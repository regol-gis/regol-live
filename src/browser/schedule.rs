//! Cooperatively discover missing byte ranges from one Wasm instance.
use super::*;
use regol::source::{RangeQuery, TileVisit, TraversalOrder, TraversalOrdinal};
use std::cell::Cell;

#[link(wasm_import_module = "range")]
unsafe extern "C" {
    fn planning() -> bool;
    fn cursor_count() -> usize;
    fn warm_output_enabled() -> bool;
    fn begin_cursor(id: usize) -> bool;
    fn cursor_blocked() -> bool;
    fn end_cursor();
    fn wait_for_cursor() -> i32;
    fn warm_pages(pages: *const u64, count: usize, unit: u32) -> i32;
}

#[derive(Default)]
pub(super) struct Schedule {
    ready_first: Cell<bool>,
    next_probe: Cell<usize>,
    last_order: Cell<Option<(regol::FeatureId, TraversalOrdinal)>>,
}

impl RangeQuery<Pages> for Pages {
    fn width(&self) -> usize {
        unsafe { cursor_count() }
    }
    fn order(&self) -> TraversalOrder {
        if self.schedule.ready_first.get() {
            TraversalOrder::Ready
        } else {
            TraversalOrder::Original
        }
    }
    fn allocate_probe(&self) -> usize {
        let id = self.schedule.next_probe.get();
        self.schedule.next_probe.set(id.wrapping_add(1));
        id
    }
    fn feature_ready(&self, feature: regol::Feature<'_, Self>, order: TraversalOrdinal) {
        self.schedule.last_order.set(Some((feature.id(), order)));
    }
    fn begin(&self, id: usize) -> bool {
        unsafe { begin_cursor(id) }
    }
    fn pending(&self) -> bool {
        unsafe { cursor_blocked() }
    }
    fn end(&self) {
        unsafe { end_cursor() }
    }
    fn wait(&self) -> io::Result<()> {
        if unsafe { wait_for_cursor() } == 1 {
            Ok(())
        } else {
            Err(io::Error::other("Cursor range failed."))
        }
    }
    fn prepare_feature(&self, feature: regol::Feature<'_, Self>) {
        if unsafe { warm_output_enabled() } {
            crate::map_output::scheduled::warm(feature);
        }
    }
    fn visit_tile(&self, _start: u64) -> TileVisit {
        if unsafe { planning() } {
            TileVisit::PlanOnly
        } else {
            TileVisit::Scan
        }
    }
    fn plan_width(&self) -> usize {
        if unsafe { planning() } { 128 } else { 0 }
    }
    fn plan_tags(&self) -> bool {
        unsafe { planning() }
    }
    fn warm_pages(&self, pages: &[u64], unit: u64) -> io::Result<()> {
        let cache = self.cache.borrow();
        let missing: Vec<_> = pages
            .iter()
            .copied()
            .filter(|&p| {
                p < self.size
                    && !cache.pages.contains_key(&Key::Page(p / PAGE * PAGE))
                    && !(p..(p + unit).min(self.size))
                        .step_by(FRAGMENT as usize)
                        .all(|offset| cache.pages.contains_key(&Key::Fragment(offset)))
            })
            .collect();
        drop(cache);
        // The worker copies the offsets before suspending the calling Wasm instance.
        if !missing.is_empty()
            && unsafe { warm_pages(missing.as_ptr(), missing.len(), unit as u32) } == 0
        {
            return Err(io::Error::other("Could not read the planned GOL ranges."));
        }
        Ok(())
    }
}

pub(super) fn execute(lib: &Library<Pages>, mut request: Request) -> Result<crate::Output, String> {
    let pages = lib.source();
    let check = cancellation_check();
    if !unsafe { warm_output_enabled() }
        || pages.width() == 0
        || !request
            .program_mut()
            .is_some_and(|program| program.windows().len() == 1)
    {
        return execute_cancellable(lib, request, &check);
    }
    pages.schedule.ready_first.set(true);
    pages.schedule.last_order.set(None);
    let result = crate::map_output::scheduled::execute(lib, request, &check, |id| {
        pages
            .schedule
            .last_order
            .get()
            .filter(|(candidate, _)| *candidate == id)
            .map(|(_, order)| order)
    });
    pages.schedule.ready_first.set(false);
    if let Ok(output) = result
        && output.limited.is_none()
    {
        return Ok(output);
    }
    // A limit or error is observable in traversal order. Replay with the cached
    // ranges so the user receives the original prefix and its exact counts.
    check()?;
    execute_cancellable(lib, query_request(lib)?, &check)
}
