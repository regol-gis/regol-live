//! Viewport tag frequencies for the selector branch being edited.
use crate::geometry::project_box;
use regol::{Library, Query, TagValue, source::Source};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Deserialize)]
pub struct SuggestRequest {
    windows: Vec<[f64; 4]>,
    selector: String,
    key: Option<String>,
    #[serde(default)]
    prefix: String,
}

#[derive(Serialize)]
pub struct Suggestions {
    /// Every spelling starting with this prefix is covered if the scan completed.
    prefix: String,
    complete: bool,
    items: Vec<Item>,
}

#[derive(Serialize)]
struct Item {
    text: String,
    count: usize,
    numeric: bool,
}

#[derive(Default)]
struct Tally {
    // Keep the last feature number to count duplicate keys on a feature once.
    entries: BTreeMap<(String, bool), (usize, usize)>,
    bytes: usize,
    prefix: String,
}

impl Tally {
    fn add(&mut self, text: String, numeric: bool, feature: usize, requested: &str) -> bool {
        if !text.starts_with(&self.prefix) {
            return true;
        }
        let key = (text, numeric);
        if let Some((count, last)) = self.entries.get_mut(&key) {
            if *last != feature {
                *count += 1;
                *last = feature;
            }
            return true;
        }
        if self.entries.len() >= 1024 || self.bytes + key.0.len() > 64 * 1024 {
            if self.prefix == requested {
                return false;
            }
            // Preserve all counts for the narrower prefix, including earlier features.
            self.prefix = requested.into();
            self.entries
                .retain(|(text, _), _| text.starts_with(requested));
            self.bytes = self.entries.keys().map(|(text, _)| text.len()).sum();
            return self.add(key.0, numeric, feature, requested);
        }
        self.bytes += key.0.len();
        self.entries.insert(key, (1, feature));
        true
    }
}

pub fn suggest_tags<S: Source>(
    lib: &Library<S>,
    request: SuggestRequest,
    stopped: impl Fn() -> bool,
) -> Result<Suggestions, String> {
    if !(1..=2).contains(&request.windows.len())
        || request.selector.len() > 65536
        || request.key.as_ref().is_some_and(|k| k.len() > 32767)
        || request.prefix.len() > 32767
    {
        return Err("Invalid tag suggestion request.".into());
    }
    let windows = request
        .windows
        .into_iter()
        .map(project_box)
        .collect::<Result<Vec<_>, _>>()?;
    let query = Query::parse(&request.selector).map_err(|e| e.to_string())?;
    let mut tally = Tally::default();
    let mut seen = HashSet::new();
    let mut visited = 0;
    let mut scan = || -> regol::Result<bool> {
        for &window in &windows {
            // Check the budget even for a selective predicate that matches nothing.
            for candidate in lib.in_bounds(window) {
                if visited >= 50_000 || (visited % 32 == 0 && stopped()) {
                    return Ok(false);
                }
                visited += 1;
                let f = candidate?;
                if !query.matches(f)? || (windows.len() > 1 && !seen.insert(f.id())) {
                    continue;
                }
                if let Some(key) = &request.key {
                    if let Some(value) = f.tag(key)? {
                        let numeric = matches!(value, TagValue::Number { .. });
                        if !tally.add(value.to_string(), numeric, visited, &request.prefix) {
                            return Ok(false);
                        }
                    }
                } else {
                    for tag in f.tags()? {
                        if !tally.add(tag?.key.into_owned(), false, visited, &request.prefix) {
                            return Ok(false);
                        }
                    }
                }
            }
        }
        Ok(true)
    };
    let complete = match scan() {
        Ok(done) => done,
        Err(_) if stopped() => false, // An interrupted range read retains the observed counts.
        Err(err) => return Err(err.to_string()),
    };
    Ok(Suggestions {
        complete,
        prefix: tally.prefix,
        items: tally
            .entries
            .into_iter()
            .map(|((text, numeric), (count, _))| Item {
                text,
                numeric,
                count,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn run(
        key: Option<&str>,
        selector: &str,
        wrapped: bool,
        stopped: impl Fn() -> bool,
    ) -> Suggestions {
        let lib =
            Library::new(include_bytes!("../web/data/monaco-2026-01-01.gol").as_slice()).unwrap();
        let window = [7.407, 43.72, 7.44, 43.75];
        let windows = vec![window; if wrapped { 2 } else { 1 }];
        suggest_tags(
            &lib,
            SuggestRequest {
                selector: selector.into(),
                windows,
                key: key.map(str::to_owned),
                prefix: String::new(),
            },
            stopped,
        )
        .unwrap()
    }

    #[test]
    fn counts_tags_before_geometry_and_deduplicates_overlapping_windows() {
        let values = run(Some("amenity"), "na", true, || false);
        assert!(values.complete);
        assert_eq!(
            values
                .items
                .iter()
                .find(|v| v.text == "cafe")
                .unwrap()
                .count,
            27
        );
        let keys = run(None, "na[amenity=cafe]", false, || false);
        assert_eq!(
            keys.items
                .iter()
                .find(|v| v.text == "outdoor_seating")
                .unwrap()
                .count,
            8
        );
        let no = run(Some("access"), "nwar[access=no]", false, || false);
        assert!(no.items.iter().any(|v| v.text == "no" && v.count > 0));
    }

    #[test]
    fn bounds_work_on_rare_selectors_and_keeps_partial_counts() {
        for selector in ["*", "n[unlikely_thing=yes]"] {
            let checks = Cell::new(0);
            let result = run(None, selector, false, || {
                checks.set(checks.get() + 1);
                checks.get() > 8
            });
            assert!(!result.complete);
            assert_eq!(result.items.is_empty(), selector != "*");
        }
    }

    #[test]
    fn narrowing_a_full_tally_keeps_earlier_matches() {
        let mut tally = Tally::default();
        for i in 0..1024 {
            assert!(tally.add(i.to_string(), false, i, "7"));
        }
        assert!(tally.add("z".into(), false, 1024, "7"));
        assert!(tally.add("7".into(), false, 1025, "7"));
        assert!(tally.add("7".into(), false, 1025, "7"));
        assert_eq!(tally.prefix, "7");
        assert_eq!(tally.entries[&("7".into(), false)].0, 2);
        assert!(tally.entries.keys().all(|(s, _)| s.starts_with('7')));
    }
}
