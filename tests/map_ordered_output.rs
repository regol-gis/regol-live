use regol::Library;
use regol_live::{execute, execute_parallel};
use serde_json::{Value, json};

const GOL: &[u8] = include_bytes!("fixtures/geography.gol");

fn result(plan: Value) -> Value {
    let lib = Library::new(GOL).unwrap();
    let request = || serde_json::from_value(plan.clone()).unwrap();
    let serial = serde_json::to_value(execute(&lib, request()).unwrap()).unwrap();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .unwrap();
    let parallel =
        serde_json::to_value(execute_parallel(&lib, request(), &|| Ok(()), &pool).unwrap())
            .unwrap();
    assert_eq!(serial, parallel);
    serial
}

#[test]
fn mixed_outputs_keep_the_set_at_each_statement_and_allow_repeated_features() {
    let value = result(json!({
        "windows": [[-1,-1,1,1]],
        "sets": [
            {"name": "first", "source": "*", "overpass": {
                "kind": "way",
                "tags": [{"key": "test:group", "op": "eq", "value": "dateline"}],
                "windows": [[-1,-1,1,1]],
            }},
            {"name": "second", "source": "n[\"test:group\"=dateline]"},
        ],
        "outputs": [
            {"after": 1, "source": "first", "name": "a", "mode": "geom", "detail": "body"},
            {"after": 1, "source": "first", "name": "a", "mode": "center", "detail": "skel"},
            {"after": 1, "source": "first", "name": "a", "mode": "count"},
            {"after": 2, "source": "second", "name": "a", "mode": "count"},
            {"after": 2, "source": "first", "name": "a", "mode": "geom"},
        ],
    }));
    assert_eq!(value["limited"], Value::Null);
    assert_eq!(
        value["outputs"],
        json!([
            {"name": "a", "mode": "geom", "detail": "body"},
            {"name": "a", "mode": "center", "detail": "skel"},
            {"name": "a", "mode": "count",
             "counts": {"nodes": 0, "ways": 1, "relations": 0, "total": 1}},
            {"name": "a", "mode": "count",
             "counts": {"nodes": 1, "ways": 0, "relations": 0, "total": 1}},
            {"name": "a", "mode": "geom"},
        ])
    );
    let features = value["features"].as_array().unwrap();
    assert_eq!(features.len(), 3);
    for (feature, group) in features.iter().zip([0, 1, 4]) {
        assert_eq!(feature["id"], "W104");
        assert_eq!(feature["properties"]["fid"], format!("{group}:W104"));
        assert_eq!(feature["properties"]["group"], group);
    }
    assert_eq!(features[0]["geometry"]["type"], "LineString");
    assert_eq!(features[0]["tags"], json!({"test:group": "dateline"}));
    assert_eq!(features[1]["geometry"]["type"], "Point");
    assert_eq!(features[1]["tags"], json!({}));
}

#[test]
fn ascending_and_quadtile_outputs_apply_different_orders() {
    let value = result(json!({
        "windows": [[-180,-1,180,1]],
        "sets": [
            {"name": "nodes", "source": "n[\"test:group\"=dateline]"},
        ],
        "outputs": [
            {"after": 1, "source": "nodes", "name": "_", "mode": "geom", "order": "asc"},
            {"after": 1, "source": "nodes", "name": "_", "mode": "geom", "order": "qt"},
        ],
    }));
    let features = value["features"].as_array().unwrap();
    let ids = |start, end| {
        features[start..end]
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(0, 6), ["N9", "N10", "N11", "N12", "N13", "N14"]);
    assert_eq!(&ids(6, 12)[..3], ["N12", "N10", "N14"]);
    assert_ne!(ids(0, 6), ids(6, 12));
}
