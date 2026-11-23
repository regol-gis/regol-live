#[cfg(target_arch = "wasm32")]
mod gob;

use crate::{MAX_REQUEST_BYTES, Request, execute, query_limits};
use regol::{DictionaryLoading, Library, source::Source};
use serde_json::json;
use std::{cell::RefCell, collections::HashMap, io};

// The single worker serializes entry into Wasm. JS writes at most size bytes
// to the live allocation, then resolves before Rust resumes.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "range")]
unsafe extern "C" {
    fn get_page(offset: u64, destination: *mut u8, size: usize, sparse: bool) -> i32;
    fn suggestion_stopped() -> bool;
    fn fetch_area_file(
        path: *const u8,
        path_size: usize,
        limit: usize,
        open_snapshot: *const u8,
        snapshot_size: usize,
    ) -> i32;
    fn copy_area_file(destination: *mut u8, size: usize) -> i32;
}
#[cfg(all(test, not(target_arch = "wasm32")))]
use tests::get_page;

const PAGE: u64 = 128 * 1024;
const FRAGMENT: u64 = 16 * 1024;
const LOCAL_AHEAD_PAGES: usize = 16 * 1024 * 1024 / PAGE as usize;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Page(u64),
    Fragment(u64),
}

impl Key {
    fn start(self) -> u64 {
        match self {
            Self::Page(start) | Self::Fragment(start) => start,
        }
    }
}

struct Page {
    bytes: Vec<u8>,
    age: u64,
    prefetched_in: Option<u64>,
}

#[derive(Default)]
struct Cache {
    pages: HashMap<Key, Page>,
    bytes: usize,
    query_id: u64,
    clock: u64,
    ahead_left: usize,
}
struct Pages {
    local: bool,
    cache_bytes: usize,
    size: u64,
    cache: RefCell<Cache>,
}

impl Pages {
    fn load(&self, cache: &mut Cache, key: Key) -> io::Result<()> {
        let start = key.start();
        let sparse = matches!(key, Key::Fragment(_));
        let mut first = start;
        let mut end = start + if sparse { FRAGMENT } else { PAGE };
        // The opening GET already holds page zero. Keep it reusable as-is.
        if !sparse && self.local && start != 0 && cache.ahead_left > 0 {
            // Spend less on read-ahead when many speculative pages went unused.
            let width = if cache.ahead_left > LOCAL_AHEAD_PAGES / 2 {
                4 * PAGE
            } else {
                2 * PAGE
            };
            let group = start / width * width;
            let mut left = cache.ahead_left;
            while first > group && left > 0 && !cache.pages.contains_key(&Key::Page(first - PAGE)) {
                first -= PAGE;
                left -= 1;
            }
            while end < self.size
                && end < group + width
                && left > 0
                && !cache.pages.contains_key(&Key::Page(end))
            {
                end += PAGE;
                left -= 1;
            }
            cache.ahead_left = left;
        }
        let length = (end.min(self.size) - first) as usize;
        let mut data = vec![0; length];
        // SAFETY: the allocation is exclusive until the bounded import returns.
        if unsafe { get_page(first, data.as_mut_ptr(), length, sparse) } != 1 {
            return Err(io::Error::other("The GOL range could not be read."));
        }
        let count = length.div_ceil(PAGE as usize);
        if !sparse {
            for offset in (first..first + length as u64).step_by(FRAGMENT as usize) {
                if let Some(fragment) = cache.pages.remove(&Key::Fragment(offset)) {
                    cache.bytes -= fragment.bytes.len();
                }
            }
        }
        while cache.bytes + length > self.cache_bytes {
            let oldest = *cache
                .pages
                .iter()
                .min_by_key(|(_, page)| page.age)
                .unwrap()
                .0;
            cache.bytes -= cache.pages.remove(&oldest).unwrap().bytes.len();
        }
        cache.bytes += length;
        let mut insert = |offset, bytes| {
            cache.pages.insert(
                if sparse {
                    Key::Fragment(offset)
                } else {
                    Key::Page(offset)
                },
                Page {
                    bytes,
                    age: cache.clock,
                    prefetched_in: (offset != start).then_some(cache.query_id),
                },
            );
        };
        if count == 1 {
            insert(first, data);
        } else {
            for (i, page) in data.chunks(PAGE as usize).enumerate() {
                insert(first + i as u64 * PAGE, page.to_vec());
            }
        }
        Ok(())
    }
}

impl Source for Pages {
    fn len(&self) -> u64 {
        self.size
    }
    fn read_buffer_size(&self) -> usize {
        4096
    }
    fn read_exact_at(&self, mut offset: u64, mut out: &mut [u8]) -> io::Result<()> {
        if offset
            .checked_add(out.len() as u64)
            .is_none_or(|end| end > self.size)
        {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let mut cache = self.cache.borrow_mut();
        while !out.is_empty() {
            let full = Key::Page(offset / PAGE * PAGE);
            let fragment = Key::Fragment(offset / FRAGMENT * FRAGMENT);
            let key = if cache.pages.contains_key(&full) {
                full
            } else if cache.pages.contains_key(&fragment) {
                fragment
            } else {
                let key = if regol_overpass::read_hints::sparse() {
                    fragment
                } else {
                    full
                };
                self.load(&mut cache, key)?;
                key
            };
            cache.clock += 1;
            let now = cache.clock;
            let query_id = cache.query_id;
            let page = cache.pages.get_mut(&key).unwrap();
            page.age = now;
            let used_read_ahead = page.prefetched_in.take() == Some(query_id);
            let tail = &page.bytes[(offset - key.start()) as usize..];
            let n = out.len().min(tail.len());
            out[..n].copy_from_slice(&tail[..n]);
            out = &mut out[n..];
            offset += n as u64;
            cache.ahead_left += usize::from(used_read_ahead);
        }
        Ok(())
    }
}

thread_local! {
    static SOURCE: RefCell<Option<Library<Pages>>> = const {RefCell::new(None)};
    static INPUT: RefCell<Vec<u8>> = const {RefCell::new(Vec::new())};
    static OUTPUT: RefCell<Vec<u8>> = const {RefCell::new(Vec::new())};
}

fn output(data: &impl serde::Serialize) -> usize {
    OUTPUT.with_borrow_mut(|buf| {
        buf.clear();
        serde_json::to_writer(&mut *buf, data).unwrap();
        buf.len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    OUTPUT.with_borrow(|buf| buf.as_ptr())
}

/// Look up one aligned 16 KiB block (possibly short at EOF) without an I/O
/// request. The download planner accesses it while the query engine is idle.
#[unsafe(no_mangle)]
pub extern "C" fn cached_block(start: u64) -> *const u8 {
    SOURCE.with_borrow(|source| {
        let Some(lib) = source else {
            return std::ptr::null();
        };
        let pages = lib.source();
        if start >= pages.size || !start.is_multiple_of(FRAGMENT) {
            return std::ptr::null();
        }
        let cache = pages.cache.borrow();
        let base = start / PAGE * PAGE;
        if let Some(page) = cache.pages.get(&Key::Page(base)) {
            page.bytes[(start - base) as usize..].as_ptr()
        } else {
            cache
                .pages
                .get(&Key::Fragment(start))
                .map_or(std::ptr::null(), |page| page.bytes.as_ptr())
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(size: usize) -> *mut u8 {
    if size > MAX_REQUEST_BYTES {
        return std::ptr::null_mut();
    }
    INPUT.with_borrow_mut(|buf| {
        buf.resize(size, 0);
        buf.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn open_gol(size: u64, local: bool) -> usize {
    let source = Pages {
        local,
        cache_bytes: (if local { 64 } else { 32 }) * 1024 * 1024,
        size,
        cache: Default::default(),
    };
    match Library::with_dictionary_loading(source, query_limits(), DictionaryLoading::OnDemand) {
        Ok(lib) => {
            SOURCE.with_borrow_mut(|s| *s = Some(lib));
            0
        }
        Err(e) => output(&json!({"error":e.to_string()})),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn start_view() -> usize {
    SOURCE.with_borrow(|lib| output(&lib.as_ref().and_then(crate::start_view::suggested_view)))
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn suggest_tags() -> usize {
    let result = INPUT
        .with_borrow(|buf| serde_json::from_slice(buf))
        .map_err(|e| e.to_string())
        .and_then(|request| {
            SOURCE.with_borrow(|source| {
                let lib = source.as_ref().ok_or("Open a dataset first.")?;
                lib.source().cache.borrow_mut().ahead_left = 0;
                crate::suggestions::suggest_tags(lib, request, || {
                    // The worker owns the current job's deadline and range budget.
                    unsafe { suggestion_stopped() }
                })
            })
        });
    match result {
        Ok(value) => output(&value),
        Err(err) => output(&json!({"error": err})),
    }
}

/// Compile without opening a dataset. Uses the same input/output buffers as query().
#[unsafe(no_mangle)]
pub extern "C" fn compile_overpass() -> usize {
    let result = INPUT.with_borrow(|bytes| {
        serde_json::from_slice::<crate::compiler::CompileRequest>(bytes)
            .map_err(|error| error.to_string())?
            .compile()
    });
    match result {
        Ok(plan) => output(&plan),
        Err(message) => output(&json!({ "error": message })),
    }
}

#[cfg(target_arch = "wasm32")]
fn read_area_file(path: &str, limit: usize, source: &impl Source) -> Result<Vec<u8>, String> {
    // The hosted planet can reuse geographic hints. Give the adapter the open GOL's
    // identity when it prepares the query manifest. Shard reads use that same view.
    let snapshot = if path == "manifest.json" {
        crate::named_area::snapshot(source).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    // Both strings are live until the worker resumes WASM with the bounded size.
    let size = match unsafe {
        fetch_area_file(
            path.as_ptr(),
            path.len(),
            limit,
            snapshot.as_ptr(),
            snapshot.len(),
        )
    } {
        -2 => return Err(format!("The area index file {path} exceeds {limit} bytes.")),
        n if n >= 0 && n as usize <= limit => n as usize,
        _ if path == "manifest.json" => {
            return Err("Named-area lookup needs a published area index for this GOL. Use a bounded way/relation selection with map_to_area, or build the matching index.".into());
        }
        _ => {
            return Err(
                "Named-area index shard unavailable. Republish the complete index for this GOL."
                    .into(),
            );
        }
    };
    let mut bytes = vec![0; size];
    // The allocation is exclusive and the worker checks the fetched length before copying.
    if unsafe { copy_area_file(bytes.as_mut_ptr(), size) } != 1 {
        return Err(format!("Reading the area index file {path} failed."));
    }
    Ok(bytes)
}

#[unsafe(no_mangle)]
pub extern "C" fn query() -> usize {
    let request = INPUT.with_borrow(|buf| serde_json::from_slice::<Request>(buf));
    let result = request.map_err(|e| e.to_string()).and_then(|req| {
        SOURCE.with_borrow(|lib| {
            let lib = lib.as_ref().ok_or("Open a dataset first.")?;
            {
                let mut cache = lib.source().cache.borrow_mut();
                cache.query_id += 1;
                cache.ahead_left = LOCAL_AHEAD_PAGES;
            }
            #[cfg(target_arch = "wasm32")]
            let req = {
                let mut req = req;
                if let Some(program) = req.program_mut() {
                    regol_overpass::area_index::hydrate_from(
                        program,
                        lib.source(),
                        |path, limit| read_area_file(path, limit, lib.source()),
                        &|| Ok(()),
                    )?;
                }
                req
            };
            execute(lib, req)
        })
    });
    match result {
        Ok(results) => output(&results),
        Err(e) => output(&json!({"error":e})),
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use regol_overpass::read_hints::with_relation_reads;

    thread_local! {
        static READS: RefCell<Vec<(u64, usize, bool)>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) unsafe fn get_page(
        offset: u64,
        destination: *mut u8,
        size: usize,
        sparse: bool,
    ) -> i32 {
        READS.with_borrow_mut(|reads| reads.push((offset, size, sparse)));
        // The caller supplies its freshly allocated buffer of exactly this size.
        for (i, byte) in unsafe { std::slice::from_raw_parts_mut(destination, size) }
            .iter_mut()
            .enumerate()
        {
            *byte = ((offset + i as u64) / FRAGMENT) as u8;
        }
        1
    }

    #[test]
    fn relation_fragments_share_the_page_cache_and_clip_at_eof() {
        let source = Pages {
            local: false,
            cache_bytes: PAGE as usize,
            size: 3 * PAGE + 7,
            cache: Default::default(),
        };
        let mut pair = [0; 2];
        with_relation_reads(|| source.read_exact_at(FRAGMENT - 1, &mut pair)).unwrap();
        assert_eq!(pair, [0, 1]);
        source.read_exact_at(FRAGMENT, &mut pair).unwrap();
        source.read_exact_at(2 * FRAGMENT - 1, &mut pair).unwrap();
        assert_eq!(pair, [1, 2]);
        assert_eq!(source.cache.borrow().bytes, PAGE as usize);
        assert_eq!(source.cache.borrow().pages.len(), 1);
        with_relation_reads(|| source.read_exact_at(4 * FRAGMENT, &mut pair)).unwrap();
        with_relation_reads(|| source.read_exact_at(3 * PAGE + 5, &mut pair)).unwrap();
        assert_eq!(pair, [24, 24]);
        assert_eq!(source.cache.borrow().bytes, 7);
        assert!(source.read_exact_at(3 * PAGE + 6, &mut pair).is_err());
        READS.with_borrow(|reads| {
            assert_eq!(
                reads.as_slice(),
                &[
                    (0, FRAGMENT as usize, true),
                    (FRAGMENT, FRAGMENT as usize, true),
                    (0, PAGE as usize, false),
                    (3 * PAGE, 7, true),
                ]
            )
        });
    }
}
