use regol_overpass::area_index;
mod assets;
use crate::Options;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use regol::{DictionaryLoading, Library, source::MappedFile};
use regol_live::suggestions::{SuggestRequest, suggest_tags};
use regol_live::{
    MAX_REQUEST_BYTES, QueryProgress, Request, execute_parallel_with_progress, query_limits,
};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    error::Error,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

#[derive(Serialize)]
pub(super) struct View {
    center: [f64; 2],
    zoom: f64,
}

impl FromStr for View {
    type Err = &'static str;
    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let invalid = "expected --view longitude,latitude,zoom (zoom 0–22)";
        let mut values = raw.split(',').map(|s| s.parse::<f64>().ok());
        match (
            values.next().flatten(),
            values.next().flatten(),
            values.next().flatten(),
        ) {
            (Some(x), Some(y), Some(z))
                if values.next().is_none()
                    && (-180.0..=180.0).contains(&x)
                    && (-90.0..=90.0).contains(&y)
                    && (0.0..=22.0).contains(&z) =>
            {
                Ok(Self {
                    center: [x, y],
                    zoom: z,
                })
            }
            _ => Err(invalid),
        }
    }
}

struct App {
    library: Library<MappedFile>,
    slots: Arc<Semaphore>,
    query_capacity: usize,
    suggestion_slot: Arc<Semaphore>,
    compiler_slots: Arc<Semaphore>,
    workers: rayon::ThreadPool,
    active: Mutex<HashMap<String, Arc<QueryState>>>,
    config: String,
    snapshot: String,
    area_index: Option<area_index::AreaIndex>,
}

async fn serve_config(State(app): State<Arc<App>>) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        app.config.clone(),
    )
}

#[derive(Default)]
struct QueryState {
    cancelled: AtomicBool,
    progress: Mutex<Option<QueryProgress>>,
}

struct CancelOnDrop<'a> {
    state: Arc<QueryState>,
    registration: Option<(&'a App, &'a str)>,
}
impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        self.state.cancelled.store(true, Ordering::Relaxed);
        if let Some((app, id)) = self.registration {
            app.active.lock().unwrap().remove(id);
        }
    }
}

async fn query_progress(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let state = app.active.lock().unwrap().get(&id).cloned();
    let response = match state {
        Some(state) => Json(*state.progress.lock().unwrap()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CACHE_CONTROL, "no-store")], response).into_response()
}

fn error(status: StatusCode, message: impl ToString) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

async fn query(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    input: Result<Json<Request>, JsonRejection>,
) -> Response {
    let mut request = match input {
        Ok(Json(request)) => request,
        Err(err) => return error(err.status(), err.body_text()),
    };
    let Ok(slot) = app.slots.clone().try_acquire_owned() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "All query workers are busy. Try again.",
        );
    };
    // Hyper drops the handler when the client abandons its request. Blocking
    // work keeps its slot until the evaluator observes the flag and returns.
    let state = Arc::new(QueryState::default());
    let mut cancel = CancelOnDrop {
        state: state.clone(),
        registration: None,
    };
    if let Some(value) = headers.get("x-regol-query-id") {
        let Ok(id) = value.to_str() else {
            return error(StatusCode::BAD_REQUEST, "Invalid query ID.");
        };
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return error(
                StatusCode::BAD_REQUEST,
                "Expected a 32-digit hexadecimal query ID.",
            );
        }
        let mut active = app.active.lock().unwrap();
        if active.contains_key(id) {
            return error(StatusCode::CONFLICT, "Query ID already in use.");
        }
        active.insert(id.to_owned(), state.clone());
        cancel.registration = Some((&app, id));
    }
    let tracked = cancel.registration.is_some();
    let app = app.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let started = Instant::now();
        let check = || {
            if state.cancelled.load(Ordering::Relaxed) {
                Err("Query cancelled.".into())
            } else {
                Ok(())
            }
        };
        if let Some(index) = &app.area_index
            && let Some(program) = request.program_mut()
            && let Err(message) = index.hydrate(program, &check)
        {
            return error(StatusCode::UNPROCESSABLE_ENTITY, message);
        }
        let output = execute_parallel_with_progress(
            &app.library,
            request,
            &check,
            &app.workers,
            &|progress| {
                if tracked {
                    *state.progress.lock().unwrap() = Some(progress);
                }
            },
        );
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let output = match output {
            Ok(output) => output,
            Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
        };
        match serde_json::to_vec(&output) {
            Ok(bytes) => (
                [
                    ("content-type", "application/json"),
                    ("cache-control", "no-store"),
                    ("x-regol-snapshot", &app.snapshot),
                    ("server-timing", &format!("query;dur={elapsed:.3}")),
                ],
                bytes,
            )
                .into_response(),
            Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err),
        }
    });
    work.await
        .unwrap_or_else(|err| error(StatusCode::INTERNAL_SERVER_ERROR, err))
}

async fn compile_query(
    State(app): State<Arc<App>>,
    Json(request): Json<regol_live::compiler::CompileRequest>,
) -> Response {
    let Ok(slot) = app.compiler_slots.clone().try_acquire_owned() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The query compiler is busy. Try again.",
        );
    };
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        match request.compile() {
            Ok(plan) => Json(plan).into_response(),
            Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        }
    })
    .await
    .unwrap_or_else(|err| error(StatusCode::INTERNAL_SERVER_ERROR, err))
}

async fn suggestions(State(app): State<Arc<App>>, Json(request): Json<SuggestRequest>) -> Response {
    let Ok(slot) = app.suggestion_slot.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if app.slots.available_permits() < app.query_capacity {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let state = Arc::new(QueryState::default());
    let _cancel = CancelOnDrop {
        state: state.clone(),
        registration: None,
    };
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let start = Instant::now();
        let result = suggest_tags(&app.library, request, || {
            state.cancelled.load(Ordering::Relaxed)
                || start.elapsed().as_millis() >= 500
                || app.slots.available_permits() < app.query_capacity
        });
        match result {
            Ok(items) => (
                [
                    ("cache-control", "no-store"),
                    ("x-regol-snapshot", app.snapshot.as_str()),
                ],
                Json(items),
            )
                .into_response(),
            Err(err) => error(StatusCode::UNPROCESSABLE_ENTITY, err),
        }
    })
    .await
    .unwrap_or_else(|err| error(StatusCode::INTERNAL_SERVER_ERROR, err))
}

pub(super) async fn serve(options: Options) -> Result<(), Box<dyn Error>> {
    // SAFETY: the command requires the file to remain immutable for the entire session.
    let source = unsafe { MappedFile::open(&options.file) }?;
    let library =
        Library::with_dictionary_loading(source, query_limits(), DictionaryLoading::OnDemand)?;
    let area_index = options
        .area_index
        .as_deref()
        .map(|directory| area_index::AreaIndex::open(directory, library.source()))
        .transpose()?;
    let view = match options.view {
        Some(view) => view,
        None => match regol_live::start_view::suggested_view(&library) {
            Some(view) => View {
                center: view.center,
                zoom: f64::from(view.zoom),
            },
            None => View {
                center: [0.0, 0.0],
                zoom: 1.0,
            },
        },
    };
    let snapshot = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let label = options
        .file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let config = format!(
        "export default {};",
        json!([{
            "id":"native", "native":true, "label":label, "path":"./api/query", "view":view
        }])
    );
    let cpus = std::thread::available_parallelism()?.get();
    let workers = rayon::ThreadPoolBuilder::new().num_threads(cpus).build()?;
    let app = Router::new()
        .route("/api/query", post(query))
        .route("/api/overpass/compile", post(compile_query))
        .route("/api/goql/validate", post(compile_query))
        .route("/api/suggest-tags", post(suggestions))
        .route("/api/query/{id}/progress", get(query_progress))
        .route("/local-datasets.js", get(serve_config))
        .route(
            "/build.json",
            get(|| async { Json(json!({ "version": env!("CARGO_PKG_VERSION") })) }),
        )
        .fallback(get(assets::asset))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(Arc::new(App {
            library,
            slots: Arc::new(Semaphore::new(cpus.min(4))),
            query_capacity: cpus.min(4),
            suggestion_slot: Arc::new(Semaphore::new(1)),
            compiler_slots: Arc::new(Semaphore::new(2)),
            workers,
            active: Mutex::default(),
            config,
            snapshot,
            area_index,
        }));
    let listener = tokio::net::TcpListener::bind(options.address).await?;
    println!("Regol Live at http://{}/", listener.local_addr()?);
    Ok(axum::serve(listener, app).await?)
}
