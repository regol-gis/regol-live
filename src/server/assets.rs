use axum::{
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};

const FILES: &[(&str, &str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

pub(super) async fn asset(uri: Uri) -> Response {
    let path = if uri.path() == "/" {
        "/index.html"
    } else {
        uri.path()
    };
    match FILES.iter().find(|(name, _, _)| *name == path) {
        Some((_, mime, bytes)) => ([(header::CONTENT_TYPE, *mime)], *bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
