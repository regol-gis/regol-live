use super::*;
use regol::{FeatureId, source::TraversalOrdinal};

pub(crate) fn warm<S: Source>(feature: Feature<'_, S>) {
    let display = Display {
        group: 0,
        centered: false,
        tags: true,
        scoped_id: false,
    };
    let _ = display.render(feature, None, MAX_VERTICES);
}

// Only a single implicit geometry output can finish in ready order. All display
// limits, skip counts and rendering still belong to the ordinary map sink.
struct Ranked<F> {
    map: MapOutput,
    ordinal: F,
    order: Vec<TraversalOrdinal>,
}

impl<'a, S: Source + 'a, F: Fn(FeatureId) -> Option<TraversalOrdinal>> OutputSink<'a, S>
    for Ranked<F>
{
    type Prepared = regol::Result<Rendered>;
    type Preparation = Display;

    fn preparation(&self, group: OutputGroup<'_>) -> Option<Display> {
        <MapOutput as OutputSink<S>>::preparation(&self.map, group)
    }

    fn group(
        &mut self,
        group: OutputGroup<'_>,
        counts: Option<Counts>,
    ) -> Result<ControlFlow<()>, String> {
        <MapOutput as OutputSink<S>>::group(&mut self.map, group, counts)
    }

    fn feature(
        &mut self,
        group: OutputGroup<'_>,
        feature: Feature<'a, S>,
        geometry: Option<Geometry>,
        prepared: Option<Self::Prepared>,
    ) -> Result<FeatureStatus, String> {
        let status = self.map.feature(group, feature, geometry, prepared)?;
        if matches!(status, FeatureStatus::Accepted) {
            self.order.push(
                (self.ordinal)(feature.id())
                    .ok_or("Missing traversal order for a completed feature.")?,
            );
        }
        Ok(status)
    }

    fn reference(&mut self, geometry: &Geometry) {
        <MapOutput as OutputSink<S>>::reference(&mut self.map, geometry);
    }
}

pub(crate) fn execute<S: Source>(
    lib: &Library<S>,
    request: Request,
    check: &impl Fn() -> Result<(), String>,
    ordinal: impl Fn(FeatureId) -> Option<TraversalOrdinal>,
) -> Result<Output, String> {
    check()?;
    let (request, overlay) = request.into_query()?;
    let mut sink = Ranked {
        map: MapOutput::new(overlay),
        ordinal,
        order: Vec::new(),
    };
    let stats = execute_stream(lib, request, &mut sink, check)?;
    let mut output = sink.map.finish(stats);
    if output.limited.is_none() {
        let mut ranked: Vec<_> = sink
            .order
            .into_iter()
            .zip(output.features.drain(..))
            .collect();
        ranked.sort_unstable_by_key(|(order, _)| *order);
        output
            .features
            .extend(ranked.into_iter().map(|(_, feature)| feature));
    }
    Ok(output)
}
