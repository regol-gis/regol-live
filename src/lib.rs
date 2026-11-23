//! Browser and native map adapters for Regol's shared query engine.
#[cfg(any(target_arch = "wasm32", test))]
mod browser;
pub mod compiler;
mod map_output;
mod request;
pub mod start_view;
pub mod suggestions;

pub use map_output::{Output, execute, execute_cancellable};
#[cfg(not(target_arch = "wasm32"))]
pub use map_output::{execute_parallel, execute_parallel_with_progress};
pub use regol_overpass::{QueryProgress, geometry, named_area};
pub use request::Request;

pub const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

pub fn query_limits() -> regol::Limits {
    regol::Limits {
        max_coordinates: 150_000,
        max_tags: 2048,
        max_members: 50_000,
        max_traversal_steps: 8_000_000,
        ..Default::default()
    }
}
