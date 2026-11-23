//! Render ordered query results for the Live map.
use crate::Request;
use regol::{Error, Feature, Geometry, Library, source::Source};
use regol_overpass::{
    Counts, ExecutionStats, FeaturePreparation, FeatureStatus, OutputDetail, OutputGroup,
    OutputMode, OutputOrder, OutputSink, SetStats, execute_stream, feature_geometry,
    geometry::{self, GeoGeometry},
    with_geometry_reads,
};
#[cfg(not(target_arch = "wasm32"))]
use regol_overpass::{QueryProgress, execute_stream_parallel};
use serde::Serialize;
use serde_json::value::{RawValue, to_raw_value};
use std::{collections::BTreeMap, ops::ControlFlow};

const MAX_FEATURES: usize = 100_000;
const MAX_VERTICES: usize = 1_500_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub(crate) features: Vec<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) counts: Option<Counts>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    outputs: Vec<Group>,
    pub(crate) limited: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    set_stats: Vec<SetStats>,
    pub(crate) skipped_geometries: usize,
    pub(crate) skipped_references: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) references: Option<Vec<GeoGeometry>>,
}

#[derive(Serialize)]
struct Group {
    name: String,
    mode: OutputMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<OutputDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<OutputOrder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    counts: Option<Counts>,
}

#[derive(Serialize)]
struct MapFeature<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    properties: MapProperties<'a>,
    geometry: GeoGeometry,
    tags: &'a BTreeMap<String, String>,
}

#[derive(Serialize)]
struct MapProperties<'a> {
    fid: &'a str,
    group: usize,
    name: Option<&'a str>,
}

#[derive(Clone, Copy)]
struct Display {
    group: usize,
    centered: bool,
    tags: bool,
    scoped_id: bool,
}

impl Display {
    fn new(group: OutputGroup<'_>) -> Self {
        Self {
            group: group.index,
            centered: group.mode == OutputMode::Center,
            tags: group.detail != Some(OutputDetail::Skel),
            scoped_id: group.ordered,
        }
    }

    fn serialize<S: Source>(
        self,
        feature: Feature<'_, S>,
        geometry: GeoGeometry,
    ) -> Result<Box<RawValue>, String> {
        let mut tags = BTreeMap::new();
        if self.tags {
            for tag in feature.tags().map_err(|error| error.to_string())? {
                let tag = tag.map_err(|error| error.to_string())?;
                tags.insert(tag.key.into_owned(), tag.value.to_string());
            }
        }
        let id = feature.id().to_string();
        let distinct_id = self.scoped_id.then(|| format!("{}:{id}", self.group));
        to_raw_value(&MapFeature {
            kind: "Feature",
            id: &id,
            properties: MapProperties {
                fid: distinct_id.as_deref().unwrap_or(&id),
                group: self.group,
                name: tags.get("name").map(String::as_str),
            },
            geometry,
            tags: &tags,
        })
        .map_err(|error| error.to_string())
    }

    fn render<S: Source>(
        self,
        feature: Feature<'_, S>,
        geometry: Option<Geometry>,
        remaining_vertices: usize,
    ) -> regol::Result<Rendered> {
        let (vertices, geometry) = if self.centered {
            if remaining_vertices == 0 {
                return Ok(Rendered::VertexLimit);
            }
            (1, feature_geometry(feature, OutputMode::Center)?)
        } else {
            let geometry = match geometry {
                Some(geometry) => geometry,
                None => with_geometry_reads(feature, |feature| feature.geometry())?,
            };
            let vertices = geometry::vertices(&geometry);
            if vertices > remaining_vertices {
                return Ok(Rendered::VertexLimit);
            }
            (vertices, GeoGeometry::from_regol(&geometry))
        };
        Ok(Rendered::Feature {
            vertices,
            json: self.serialize(feature, geometry),
        })
    }
}

enum Rendered {
    VertexLimit,
    Feature {
        vertices: usize,
        json: Result<Box<RawValue>, String>,
    },
}

impl<'a, S: Source + 'a> FeaturePreparation<'a, S> for Display {
    type Prepared = regol::Result<Rendered>;

    fn prepare(
        &self,
        feature: Feature<'a, S>,
        geometry: Option<Geometry>,
    ) -> (Self::Prepared, usize) {
        let render = self.render(feature, geometry, MAX_VERTICES);
        let bytes = match &render {
            Ok(Rendered::Feature { json: Ok(json), .. }) => json.get().len(),
            _ => 0,
        };
        (render, bytes)
    }
}

struct MapOutput {
    output: Output,
    vertices: usize,
    bytes: usize,
}

impl MapOutput {
    fn new(overlay: bool) -> Self {
        Self {
            output: Output {
                features: Vec::new(),
                counts: None,
                outputs: Vec::new(),
                limited: None,
                set_stats: Vec::new(),
                skipped_geometries: 0,
                skipped_references: 0,
                references: overlay.then(Vec::new),
            },
            vertices: 0,
            bytes: 0,
        }
    }

    fn finish(mut self, stats: ExecutionStats) -> Output {
        self.output.set_stats = stats.sets;
        self.output.skipped_geometries = stats.skipped_geometries;
        self.output.skipped_references = stats.skipped_references;
        self.output
    }
}

impl<'a, S: Source + 'a> OutputSink<'a, S> for MapOutput {
    type Prepared = regol::Result<Rendered>;
    type Preparation = Display;

    fn preparation(&self, group: OutputGroup<'_>) -> Option<Display> {
        (group.mode != OutputMode::Count).then(|| Display::new(group))
    }

    fn group(
        &mut self,
        group: OutputGroup<'_>,
        counts: Option<Counts>,
    ) -> Result<ControlFlow<()>, String> {
        if group.ordered {
            let group = Group {
                name: group.name.to_owned(),
                mode: group.mode,
                detail: group.detail,
                order: group.order,
                counts,
            };
            self.bytes += serde_json::to_vec(&group)
                .map_err(|error| error.to_string())?
                .len()
                + 1;
            if self.bytes > MAX_BYTES {
                self.output.limited = Some("output size");
                return Ok(ControlFlow::Break(()));
            }
            self.output.outputs.push(group);
        } else if counts.is_some() {
            self.output.counts = counts;
        }
        Ok(ControlFlow::Continue(()))
    }

    fn feature(
        &mut self,
        group: OutputGroup<'_>,
        feature: Feature<'a, S>,
        geometry: Option<Geometry>,
        prepared: Option<Self::Prepared>,
    ) -> Result<FeatureStatus, String> {
        if self.output.features.len() == MAX_FEATURES {
            self.output.limited = Some("feature");
            return Ok(FeatureStatus::Stop);
        }
        let rendered = prepared.unwrap_or_else(|| {
            Display::new(group).render(feature, geometry, MAX_VERTICES - self.vertices)
        });
        match rendered {
            Ok(Rendered::VertexLimit) => self.output.limited = Some("vertex"),
            Ok(Rendered::Feature { vertices, json }) => {
                self.vertices += vertices;
                if self.vertices > MAX_VERTICES {
                    self.output.limited = Some("vertex");
                } else {
                    let json = json?;
                    self.bytes += json.get().len();
                    if self.bytes <= MAX_BYTES {
                        self.output.features.push(json);
                        return Ok(FeatureStatus::Accepted);
                    }
                    self.output.limited = Some("output size");
                }
            }
            Err(Error::Geometry(_)) => return Ok(FeatureStatus::SkippedGeometry),
            Err(error) => return Err(format!("{}: {error}", feature.id())),
        }
        Ok(FeatureStatus::Stop)
    }

    fn reference(&mut self, geometry: &Geometry) {
        if let Some(references) = &mut self.output.references {
            references.push(GeoGeometry::from_regol(geometry));
        }
    }
}

pub fn execute<S: Source>(library: &Library<S>, request: Request) -> Result<Output, String> {
    execute_cancellable(library, request, &|| Ok(()))
}

pub fn execute_cancellable<S: Source>(
    library: &Library<S>,
    request: Request,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Output, String> {
    check()?;
    let (request, overlay) = request.into_query()?;
    let mut sink = MapOutput::new(overlay);
    let stats = execute_stream(library, request, &mut sink, check)?;
    Ok(sink.finish(stats))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn execute_parallel<S: Source + Sync>(
    library: &Library<S>,
    request: Request,
    check: &(impl Fn() -> Result<(), String> + Sync),
    pool: &rayon::ThreadPool,
) -> Result<Output, String> {
    execute_parallel_with_progress(library, request, check, pool, &|_| {})
}

#[cfg(not(target_arch = "wasm32"))]
pub fn execute_parallel_with_progress<S: Source + Sync>(
    library: &Library<S>,
    request: Request,
    check: &(impl Fn() -> Result<(), String> + Sync),
    pool: &rayon::ThreadPool,
    progress: &(impl Fn(QueryProgress) + Sync),
) -> Result<Output, String> {
    check()?;
    let (request, overlay) = request.into_query()?;
    let mut sink = MapOutput::new(overlay);
    let stats = execute_stream_parallel(library, request, &mut sink, check, pool, progress)?;
    Ok(sink.finish(stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use regol::Query;

    #[test]
    fn map_caps_stop_before_committing_the_next_output() {
        let gol = &include_bytes!("../tests/fixtures/stress.gol")[..];
        let library = Library::new(gol).unwrap();
        let feature = library
            .select(&Query::parse("n").unwrap())
            .next()
            .unwrap()
            .unwrap();
        let group = OutputGroup {
            index: 0,
            name: "points",
            mode: OutputMode::Center,
            detail: None,
            order: None,
            ordered: true,
        };

        let mut map = MapOutput::new(false);
        map.output.features = vec![to_raw_value(&0).unwrap(); MAX_FEATURES];
        let status = map.feature(group, feature, None, None).unwrap();
        assert!(matches!(status, FeatureStatus::Stop));
        assert_eq!(map.output.limited, Some("feature"));
        assert_eq!(map.output.features.len(), MAX_FEATURES);

        let mut map = MapOutput::new(false);
        map.vertices = MAX_VERTICES;
        let (prepared, _) = Display::new(group).prepare(feature, None);
        let status = map.feature(group, feature, None, Some(prepared)).unwrap();
        assert!(matches!(status, FeatureStatus::Stop));
        assert_eq!(map.output.limited, Some("vertex"));
        assert!(map.output.features.is_empty());

        let mut map = MapOutput::new(false);
        map.bytes = MAX_BYTES;
        let status = map.feature(group, feature, None, None).unwrap();
        assert!(matches!(status, FeatureStatus::Stop));
        assert_eq!(map.output.limited, Some("output size"));
        assert!(map.output.features.is_empty());

        let mut map = MapOutput::new(false);
        map.bytes = MAX_BYTES;
        let status = <MapOutput as OutputSink<'_, &[u8]>>::group(&mut map, group, None).unwrap();
        assert!(status.is_break());
        assert_eq!(map.output.limited, Some("output size"));
        assert!(map.output.outputs.is_empty());
    }
}
