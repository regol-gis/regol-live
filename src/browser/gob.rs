//! WASM interface for a worker-owned, incrementally populated GOL.
use super::{INPUT, cancellation_check, output};
use crate::{Request, execute_cancellable, geometry::project_box, query_limits};
use regol::gob::{GobCatalog, GobStore, TileEntry};
use serde::Serialize;
use serde_json::json;
use std::cell::RefCell;

const MAX_COMPRESSED_INPUT: usize = 128 * 1024 * 1024;
const MAX_STORE_BYTES: usize = 320 * 1024 * 1024;
const MAX_AREA_TILES: usize = 256;

thread_local! {
    static STORE: RefCell<Option<GobStore>> = const { RefCell::new(None) };
    static COMPRESSED: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn gob_input_buffer(size: usize) -> *mut u8 {
    if size == 0 || size > MAX_COMPRESSED_INPUT {
        return std::ptr::null_mut();
    }
    COMPRESSED.with_borrow_mut(|bytes| {
        bytes.clear();
        if bytes.try_reserve_exact(size).is_err() {
            return std::ptr::null_mut();
        }
        bytes.resize(size, 0);
        bytes.as_mut_ptr()
    })
}

fn with_store(f: impl FnOnce(&GobStore) -> Result<usize, String>) -> usize {
    STORE.with_borrow(|store| {
        store
            .as_ref()
            .ok_or_else(|| "Open a GOB first.".to_owned())
            .and_then(f)
            .unwrap_or_else(|error| output(&json!({ "error": error })))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn gob_open() -> usize {
    let bytes = COMPRESSED.take();
    let result = GobCatalog::open(&bytes)
        .and_then(|catalog| GobStore::with_limits(catalog, MAX_STORE_BYTES, query_limits()));
    match result {
        Ok(store) => {
            let catalog = store.catalog();
            let tileset: String = catalog
                .tileset_id()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            let n = output(&json!({
                "tileset": tileset, "revision": catalog.revision(), "size": catalog.archive_len()
            }));
            STORE.set(Some(store));
            n
        }
        Err(error) => output(&json!({ "error": error.to_string() })),
    }
}

#[derive(Serialize)]
struct Entry {
    tip: u32,
    offset: u64,
    length: u32,
    loaded: bool,
}

fn entry(store: &GobStore, tip: u32) -> Result<Entry, String> {
    let TileEntry { offset, len, .. } = store
        .catalog()
        .tile(tip)
        .ok_or_else(|| format!("Tile {tip} is absent from this GOB."))?;
    Ok(Entry {
        tip,
        offset,
        length: len,
        loaded: store.is_loaded(tip),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn gob_plan(w: f64, s: f64, e: f64, n: f64) -> usize {
    with_store(|store| {
        let bounds = project_box([w, s, e, n])?;
        let tips = store.catalog().tiles_in_bounds(bounds);
        if tips.len() > MAX_AREA_TILES {
            return Ok(output(&json!({ "tileLimit": MAX_AREA_TILES })));
        }
        let tiles = tips
            .into_iter()
            .map(|tip| entry(store, tip))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(output(&json!({ "tiles": tiles })))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn gob_entry(tip: u32) -> usize {
    with_store(|store| Ok(output(&entry(store, tip)?)))
}

#[unsafe(no_mangle)]
pub extern "C" fn gob_import(tip: u32) -> usize {
    let chunk = COMPRESSED.take();
    STORE.with_borrow_mut(|store| {
        let Some(store) = store else {
            return output(&json!({ "error": "Open a GOB first." }));
        };
        match store.import_tile(tip, &chunk) {
            Ok(()) => 0,
            Err(regol::Error::Limit(
                "uncompressed GOB chunk bytes" | "converted GOB tile bytes" | "retained GOB store bytes",
            )) => output(&json!({
                "error": format!("This query needs more than {} MiB of decoded tiles. Zoom in to query a smaller area. Your download is still available.", MAX_STORE_BYTES / (1024 * 1024)),
                "decodedLimit": true,
            })),
            Err(error) => output(&json!({ "error": error.to_string() })),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn gob_query() -> usize {
    with_store(|store| {
        let request = INPUT
            .with_borrow(|buf| serde_json::from_slice::<Request>(buf))
            .map_err(|error| error.to_string())?;
        store.take_missing_tile();
        let result = execute_cancellable(store.library(), request, &cancellation_check());
        if let Some(tip) = store.take_missing_tile() {
            return Ok(output(&json!({ "missingTile": tip })));
        }
        result.map(|features| output(&features))
    })
}
