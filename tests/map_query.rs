use regol::{
    Library, Point, Query, SpatialFilter, SpatialPredicate,
    units::{Length, length::meter},
};
use regol_live::{execute, execute_parallel_with_progress, geometry};
use regol_overpass::{OutputMode, feature_geometry};
use serde_json::{Value, json};
use std::collections::HashSet;

const STRESS: &[u8] = include_bytes!("fixtures/stress.gol");
const MONACO: &[u8] = include_bytes!("../web/data/monaco-2026-01-01.gol");

fn map_output(library: &Library<&[u8]>, plan: Value) -> Result<Value, String> {
    let result = execute(library, serde_json::from_value(plan).unwrap())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

fn features(output: &Value) -> &[Value] {
    output["features"].as_array().unwrap()
}

fn feature_ids(output: &Value) -> HashSet<String> {
    features(output)
        .iter()
        .map(|feature| feature["id"].as_str().unwrap().to_owned())
        .collect()
}

fn skips(output: &Value) -> (u64, u64) {
    (
        output["skippedGeometries"].as_u64().unwrap(),
        output["skippedReferences"].as_u64().unwrap(),
    )
}

fn coordinates(p: Point) -> [f64; 2] {
    let pos = p.lon_lat();
    use regol::units::angle::degree;
    [pos.longitude.get::<degree>(), pos.latitude.get::<degree>()]
}

fn predicates() -> [(&'static str, SpatialPredicate); 9] {
    [
        ("intersects", SpatialPredicate::Intersects),
        ("contains", SpatialPredicate::Contains),
        ("within", SpatialPredicate::Within),
        ("covered_by", SpatialPredicate::CoveredBy),
        ("crosses", SpatialPredicate::Crosses),
        ("touches", SpatialPredicate::Touches),
        ("overlaps", SpatialPredicate::Overlaps),
        ("disjoint", SpatialPredicate::Disjoint),
        (
            "within_distance",
            SpatialPredicate::WithinDistance(Length::new::<meter>(30.0)),
        ),
    ]
}

#[test]
fn parallel_results_match_serial_order_across_batches_and_repeated_windows() {
    let lib = Library::new(MONACO).unwrap();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .build()
        .unwrap();
    let window = [7.407, 43.72, 7.44, 43.75];
    let request = json!({
        "windows": [window, window],
        "sets": [
            {"name":"parks","source":"a[leisure=park,garden]"},
            {"name":"inparks","source":"nwa","filters":[{"predicate":"intersects","reference":"parks"}]},
            {"name":"copy","source":"$inparks"},
            {"name":"others","source":"nwa"}
        ],
        "show":["inparks", "copy", "others"]
    });
    let parse = || serde_json::from_value(request.clone()).unwrap();
    let serial = execute(&lib, parse()).unwrap();
    let serialized = serde_json::to_value(&serial).unwrap();
    assert!(features(&serialized).len() > 1024);
    assert!(serialized["skippedGeometries"].as_u64().unwrap() > 0);
    let updates = std::sync::Mutex::new(Vec::new());
    let parallel = execute_parallel_with_progress(&lib, parse(), &|| Ok(()), &pool, &|scan| {
        updates
            .lock()
            .unwrap()
            .push((scan.set_index, scan.candidates_read));
    })
    .unwrap();
    let updates = updates.into_inner().unwrap();
    assert_eq!(
        updates
            .iter()
            .filter(|(_, count)| *count == 0)
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3],
    );
    assert!(updates.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(updates.last().unwrap().1 >= 1024);
    assert_eq!(
        serde_json::to_vec(&serial).unwrap(),
        serde_json::to_vec(&parallel).unwrap()
    );
}

#[test]
fn bounding_box_centers_and_counts_work_without_assembling_geometries() {
    let lib = Library::with_limits(
        MONACO,
        regol::Limits {
            max_coordinates: 4,
            ..Default::default()
        },
    )
    .unwrap();
    let window = [7.407, 43.72, 7.44, 43.75];
    let selector = "a[boundary=administrative][name=Monaco]";
    let run = |output| {
        let request = json!({
            "windows":[window], "sets":[{"name":"boundary", "source":selector}],
            "show":["boundary"], "output":output
        });
        map_output(&lib, request)
    };
    assert!(
        run("geom")
            .err()
            .unwrap()
            .contains("resource limit exceeded")
    );
    let counted = run("count").unwrap();
    assert_eq!(counted["counts"]["total"], 2);
    assert!(features(&counted).is_empty());
    assert_eq!(counted["skippedGeometries"], 0);

    let centered = run("center").unwrap();
    assert_eq!(features(&centered).len(), 2);
    let expected: std::collections::HashMap<_, _> = lib
        .select_in(
            &Query::parse(selector).unwrap(),
            geometry::project_box(window).unwrap(),
        )
        .map(|f| {
            let f = f.unwrap();
            let bounds = f.bounds().unwrap();
            let [w, s] = coordinates(bounds.min);
            let [e, n] = coordinates(bounds.max);
            (f.id().to_string(), [(w + e) / 2.0, (s + n) / 2.0])
        })
        .collect();
    for feature in features(&centered) {
        assert_eq!(feature["geometry"]["type"], "Point");
        assert_eq!(feature["tags"]["name"], "Monaco");
        let expected = expected[feature["id"].as_str().unwrap()];
        for (i, expected) in expected.iter().enumerate() {
            assert!(
                (feature["geometry"]["coordinates"][i].as_f64().unwrap() - expected).abs() < 1e-8
            );
        }
    }
}

#[test]
fn chained_sets_use_filtered_members_and_show_only_the_requested_union() {
    let lib = Library::new(MONACO).unwrap();
    let windows = json!([[7.407, 43.72, 7.44, 43.75]]);
    let run = |mut request: Value| {
        request["windows"] = windows.clone();
        map_output(&lib, request).unwrap()
    };
    let parks = "a[leisure=park,garden]";
    let benches = "n[amenity=bench]";
    let cafes = "na[amenity=cafe]";
    let park_benches =
        run(json!({"selector":benches, "spatial":{"selector":parks,"predicate":"within"}}));
    assert!(!features(&park_benches).is_empty());
    let geometries: Vec<_> = features(&park_benches)
        .iter()
        .map(|f| f["geometry"].clone())
        .collect();
    let near = run(
        json!({"selector":cafes,"spatial":{"geometry":{"type":"GeometryCollection","geometries":geometries},"predicate":"within_distance","meters":150}}),
    );
    let expected = feature_ids(&near);
    assert!(!expected.is_empty());
    assert!(expected.len() < features(&run(json!({"selector":cafes}))).len());
    let sets = json!([
        {"name":"parks","source":parks},
        {"name":"benches","source":benches,"filters":[{"predicate":"within","reference":"parks"}]},
        {"name":"cafes","source":cafes,"filters":[{"predicate":"within_distance","reference":"benches","meters":150}]},
        {"name":"also","source":"$cafes"}
    ]);
    let only = run(json!({"sets":sets,"show":["cafes"]}));
    assert_eq!(feature_ids(&only), expected);
    assert!(only.get("references").is_none());
    let both = run(json!({"sets":sets,"show":["benches","also","cafes"]}));
    let union: HashSet<_> = expected
        .union(&feature_ids(&park_benches))
        .cloned()
        .collect();
    assert_eq!(feature_ids(&both), union);
    assert_eq!(features(&both).len(), union.len());
}

#[test]
fn incomplete_boundaries_are_counted_once_across_windows_and_selectors() {
    let lib = Library::new(MONACO).unwrap();
    let window = [7.407, 43.72, 7.44, 43.75];
    let valid = "a[boundary=administrative][name=Monaco]";
    let mixed = "a[boundary=administrative][name=France,Monaco]";
    let run = |selector: &str, spatial: Value| {
        let request =
            json!({"selector": selector, "windows": [window, window], "spatial": spatial});
        map_output(&lib, request).unwrap()
    };
    let expected = feature_ids(&run(valid, Value::Null));
    assert_eq!(expected.len(), 2);
    // The France relation in the extract has an unclosed polygon chain.
    let plain = run(mixed, Value::Null);
    assert_eq!(feature_ids(&plain), expected);
    assert_eq!(skips(&plain), (1, 0));
    let both = run(mixed, json!({"predicate": "intersects", "selector": mixed}));
    assert_eq!(feature_ids(&both), expected);
    assert_eq!(both["references"].as_array().unwrap().len(), 2);
    assert_eq!(skips(&both), (1, 1));
    let invalid = "a[boundary=administrative][name=France]";
    for predicate in ["intersects", "disjoint"] {
        let out = run(valid, json!({"predicate": predicate, "selector": invalid}));
        assert_eq!(
            features(&out).len(),
            if predicate == "disjoint" { 2 } else { 0 }
        );
        assert!(out["references"].as_array().unwrap().is_empty());
        assert_eq!(skips(&out), (1, 1));
    }
}

#[test]
fn invalid_topology_is_skipped_during_matching_and_reference_preparation() {
    let lib = Library::new(MONACO).unwrap();
    let window = [7.407, 43.72, 7.44, 43.75];
    let run = |selector: &str, reference: &str| {
        let request = json!({"selector": selector, "windows": [window, window],
            "spatial": {"predicate": "within", "selector": reference}});
        map_output(&lib, request).unwrap()
    };
    let monaco = "a[boundary=administrative][name=Monaco]";
    // The museum relation assembles, but two polygon components share an edge.
    let mixed = format!(r#"{monaco},r[name="Nouveau Musée National de Monaco"]"#);
    let expected = feature_ids(&run(monaco, monaco));
    assert_eq!(expected.len(), 2);
    let candidates = run(&mixed, monaco);
    assert_eq!(feature_ids(&candidates), expected);
    assert_eq!(skips(&candidates), (1, 0));
    let references = run(monaco, &mixed);
    assert_eq!(feature_ids(&references), expected);
    assert_eq!(references["references"].as_array().unwrap().len(), 2);
    assert_eq!(skips(&references), (1, 1));
}

#[test]
fn ordered_map_outputs_respect_the_feature_display_cap() {
    let library = Library::new(MONACO).unwrap();
    let window = [7.407, 43.72, 7.44, 43.75];
    let sets = json!([{"name": "nodes", "source": "n"}]);
    let count = json!({"after": 1, "source": "nodes", "name": "nodes", "mode": "count"});
    let run = |outputs| {
        map_output(
            &library,
            json!({"windows": [window], "sets": sets, "outputs": outputs}),
        )
        .unwrap()
    };
    let counted = run(vec![count.clone()]);
    let nodes = counted["outputs"][0]["counts"]["nodes"].as_u64().unwrap();
    let repeats = (100_000 / nodes + 1) as usize;
    let mut outputs = vec![
        json!({"after": 1, "source": "nodes", "name": "nodes", "mode": "center", "detail": "skel"});
        repeats
    ];
    outputs.push(count);
    let output = run(outputs);
    assert_eq!(output["limited"], "feature");
    assert_eq!(features(&output).len(), 100_000);
}

#[test]
fn a_geometry_read_hitting_a_resource_limit_still_fails_the_query() {
    let lib = Library::with_limits(
        MONACO,
        regol::Limits {
            max_coordinates: 4,
            ..Default::default()
        },
    )
    .unwrap();
    let selector = "a[boundary=administrative][name=Monaco]";
    for spatial in [
        Value::Null,
        json!({"predicate": "within", "selector": selector}),
    ] {
        let request = json!({"selector": selector, "windows": [[7.407, 43.72, 7.44, 43.75]], "spatial": spatial});
        let error = map_output(&lib, request).unwrap_err();
        assert!(error.contains("resource limit exceeded"), "{error}");
    }
}

#[test]
fn legacy_geometry_predicates_match_native_feature_filters() {
    let lib = Library::new(STRESS).unwrap();
    let operand = lib
        .select(&Query::parse(r#"a[name="Area 81"]"#).unwrap())
        .next()
        .unwrap()
        .unwrap();
    let geometry = feature_geometry(operand, OutputMode::Geom).unwrap();
    let bounds = operand.bounds().unwrap();
    let [min_x, min_y] = coordinates(bounds.min);
    let [max_x, max_y] = coordinates(bounds.max);
    let window = [min_x - 0.002, min_y - 0.002, max_x + 0.002, max_y + 0.002];
    let bbox = geometry::project_box(window).unwrap();
    let query = Query::parse("nwa").unwrap();
    for (wire, native) in predicates() {
        let request = json!({"selector":"nwa", "windows":[window,window], "spatial":{
            "predicate":wire,"meters":30.0,"geometry":geometry
        }});
        let out = map_output(&lib, request).unwrap();
        let expected_filter = SpatialFilter::from_feature(native, operand).unwrap();
        let expected: HashSet<_> = lib
            .select_in(&query, bbox)
            .map(Result::unwrap)
            .filter(|&f| expected_filter.matches(f).unwrap())
            .map(|f| f.id().to_string())
            .collect();
        let actual = feature_ids(&out);
        assert_eq!(
            actual.len(),
            features(&out).len(),
            "duplicate IDs for {wire}"
        );
        assert_eq!(actual, expected, "{wire}");
    }
}

#[test]
fn reference_queries_match_individual_native_operands() {
    let lib = Library::new(STRESS).unwrap();
    let window = [-0.00166, 51.00020, -0.00128, 51.00061];
    let bbox = geometry::project_box(window).unwrap();
    let refs: Vec<_> = lib
        .select_in(&Query::parse("a[building]").unwrap(), bbox)
        .map(Result::unwrap)
        .collect();
    assert!(refs.len() > 1);
    for (wire, predicate) in predicates() {
        let request = json!({
            "selector": "nwa", "windows": [window, window],
            "spatial": {"selector":"a[building]", "predicate":wire, "meters":30}
        });
        let out = map_output(&lib, request).unwrap();
        assert_eq!(out["references"].as_array().unwrap().len(), refs.len());
        let filters: Vec<_> = refs
            .iter()
            .map(|&f| SpatialFilter::from_feature(predicate, f).unwrap())
            .collect();
        let expected = lib
            .select_in(&Query::parse("nwa").unwrap(), bbox)
            .map(Result::unwrap)
            .filter(|&f| {
                if predicate == SpatialPredicate::Disjoint {
                    filters.iter().all(|filter| filter.matches(f).unwrap())
                } else {
                    filters.iter().any(|filter| filter.matches(f).unwrap())
                }
            })
            .map(|f| f.id().to_string())
            .collect();
        let actual = feature_ids(&out);
        assert_eq!(features(&out).len(), actual.len());
        assert_eq!(actual, expected, "{wire}");
    }
}
