//! The explorer accepts the ordered set plan and its original selector/spatial request.
use regol_overpass::{Request as Query, geometry::GeoGeometry};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(untagged)]
enum Body {
    Program(Query),
    Selector {
        #[serde(default)]
        windows: Vec<[f64; 4]>,
        selector: String,
        spatial: Option<Spatial>,
    },
}

#[derive(Deserialize)]
struct Spatial {
    predicate: String,
    geometry: Option<GeoGeometry>,
    selector: Option<String>,
    meters: Option<f64>,
}

#[derive(Deserialize)]
#[serde(transparent)]
pub struct Request(Body);

impl Request {
    /// Only ordered programs can contain named-area lookups.
    pub fn program_mut(&mut self) -> Option<&mut Query> {
        match &mut self.0 {
            Body::Program(query) => Some(query),
            Body::Selector { .. } => None,
        }
    }

    pub(crate) fn into_query(self) -> Result<(Query, bool), String> {
        let windows = match &self.0 {
            Body::Program(query) => query.windows(),
            Body::Selector { windows, .. } => windows,
        };
        if !(1..=2).contains(&windows.len()) {
            return Err("A query needs a viewport.".into());
        }
        match self.0 {
            Body::Program(query) => Ok((query, false)),
            Body::Selector {
                windows,
                selector,
                spatial,
            } => {
                let mut sets = Vec::new();
                let mut filters = Vec::new();
                let mut geometry = None;
                if let Some(spatial) = spatial {
                    let reference = match (spatial.selector, spatial.geometry) {
                        (Some(source), None) => {
                            sets.push(json!({"name": "reference", "source": source}));
                            "reference"
                        }
                        (None, Some(shape)) => {
                            geometry = Some(shape);
                            "geometry"
                        }
                        _ => {
                            return Err(
                                "Supply one reference geometry or reference GOQL selector.".into(),
                            );
                        }
                    };
                    filters.push(json!({
                        "predicate": spatial.predicate, "reference": reference, "meters": spatial.meters,
                    }));
                }
                let show_references = !sets.is_empty();
                sets.push(json!({"name": "result", "source": selector, "filters": filters}));
                let query = serde_json::from_value(json!({
                    "sets": sets, "show": ["result"], "geometry": geometry, "windows": windows,
                }))
                .map_err(|err| err.to_string())?;
                Ok((query, show_references))
            }
        }
    }
}
