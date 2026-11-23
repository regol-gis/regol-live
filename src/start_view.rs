//! Pick a starting location without scanning a country or planet for place nodes.
use crate::geometry::coordinates;
use regol::{Bounds, Feature, Library, Point, Query, source::Source};
use serde::Serialize;
use std::{cmp::Reverse, collections::BTreeMap};

#[derive(Debug, Serialize)]
pub struct StartView {
    pub center: [f64; 2],
    pub zoom: u8,
}

fn midpoint(b: Bounds) -> Point {
    Point {
        x: b.min.x.midpoint(b.max.x),
        y: b.min.y.midpoint(b.max.y),
    }
}

// Count detailed leaves per zoom-10 square. Subdivision in a GOL is driven by
// feature density. Read only the compact directory, never the tile payloads.
fn dense_square<S: Source>(lib: &Library<S>) -> Option<Bounds> {
    let source = lib.source();
    let mut header = [0; 256];
    source.read_exact_at(0, &mut header).ok()?;
    let word = |buf: &[u8], i: usize| {
        Some(u32::from_le_bytes(
            buf.get(i..i.checked_add(4)?)?.try_into().ok()?,
        ))
    };
    let base = u64::from(word(
        &header,
        128 + usize::from(lib.active_snapshot()) * 64 + 24,
    )?) * 4096;
    let mut len = [0; 4];
    source.read_exact_at(base, &mut len).ok()?;
    let length = u32::from_le_bytes(len) as usize;
    if !(4..=2 * 1024 * 1024).contains(&length) {
        return None;
    }
    let mut index = vec![0; length];
    source.read_exact_at(base + 4, &mut index).ok()?;
    let bits = word(&header, 96)?;
    let zooms: Vec<u32> = (0..=12).filter(|z| bits & (1 << z) != 0).collect();
    let mut stack = vec![(0usize, 0usize, 0u32, 0u32)];
    let mut squares = BTreeMap::new();
    let mut remaining = length / 4;
    while let Some((mut entry, level, x, y)) = stack.pop() {
        remaining = remaining.checked_sub(1)?;
        let zoom = zooms[level];
        let tile = word(&index, entry)?;
        let branch = tile & 3 == 1;
        if branch {
            entry = entry.checked_add_signed((tile as i32 & !3) as isize)?;
        }
        let page = word(&index, entry)?;
        if page & 3 != 2 || page >> 2 == 0 {
            continue;
        }
        if (level == 0 || branch)
            && let Some(next) = zooms.get(level + 1)
        {
            let width = 1 << (next - zoom);
            let mut mask = u64::from(word(&index, entry + 4)?);
            let mut child = entry + 8;
            if width == 8 {
                mask |= u64::from(word(&index, child)?) << 32;
                child += 4;
            }
            if mask != 0 {
                while mask != 0 {
                    let i = mask.trailing_zeros();
                    if i >= width * width {
                        return None;
                    }
                    stack.push((
                        child,
                        level + 1,
                        x * width + i % width,
                        y * width + i / width,
                    ));
                    mask &= mask - 1;
                    child += 4;
                }
                continue;
            }
        }
        let z = zoom.min(10);
        let square = (z, x >> (zoom - z), y >> (zoom - z));
        *squares.entry(square).or_insert(0u32) += 1;
    }
    let ((z, x, y), _) = squares
        .into_iter()
        .max_by_key(|&(key, count)| (key.0, count, Reverse(key)))?;
    // A coarse worldwide tile gives no useful search bounds.
    if z < 7 {
        return None;
    }
    let width = 1i64 << (32 - z);
    let left = i64::from(i32::MIN) + i64::from(x) * width;
    let top = i64::from(i32::MAX) - i64::from(y) * width;
    Bounds::new(
        left as i32,
        (top - width + 1) as i32,
        (left + width - 1) as i32,
        top as i32,
    )
    .ok()
}

fn feature_center<S: Source>(lib: &Library<S>, bounds: Bounds) -> Option<Point> {
    lib.in_bounds(bounds)
        .take(32)
        .map_while(Result::ok)
        .filter_map(|f| f.bounds().ok())
        .min_by_key(|b| {
            (i64::from(b.max.x) - i64::from(b.min.x)).max(i64::from(b.max.y) - i64::from(b.min.y))
        })
        .map(midpoint)
}

fn place_rank<S: Source>(f: Feature<'_, S>) -> regol::Result<(u8, bool, u64, Reverse<u64>)> {
    let class = match f.tag("place")?.map(|t| t.to_string()).as_deref() {
        Some("city") => 4,
        Some("town") => 3,
        Some("village") => 2,
        _ => 1,
    };
    let capital = f
        .tag("capital")?
        .is_some_and(|v| matches!(v.to_string().as_str(), "yes" | "2"));
    let population = f
        .tag("population")?
        .and_then(|v| v.as_number())
        .unwrap_or(0.0) as u64;
    Ok((class, capital, population, Reverse(f.id().id)))
}

pub fn suggested_view<S: Source>(lib: &Library<S>) -> Option<StartView> {
    let small = lib.source().len() <= 2 * 1024 * 1024;
    let square = if small { None } else { dense_square(lib) };
    let mut fallback = square.map(midpoint);
    let bounds = if small {
        Bounds::WORLD
    } else if let Some(b) = square {
        b
    } else {
        let p = feature_center(lib, Bounds::WORLD)?;
        fallback = Some(p);
        let radius = 1 << 21;
        Bounds::new(
            p.x.saturating_sub(radius),
            p.y.saturating_sub(radius),
            p.x.saturating_add(radius),
            p.y.saturating_add(radius),
        )
        .ok()?
    };
    let query = Query::parse("n[place=city,town,village,hamlet]").ok()?;
    let mut best = None;
    if let Ok(prepared) = query.prepare(lib) {
        // A city's centre often occupies the middle of a dense square. Try
        // the central third first to spare range readers its outer suburbs.
        let dx = (bounds.max.x.abs_diff(bounds.min.x) / 3) as i32;
        let dy = (bounds.max.y.abs_diff(bounds.min.y) / 3) as i32;
        let inner = (!small).then(|| Bounds {
            min: Point {
                x: bounds.min.x + dx,
                y: bounds.min.y + dy,
            },
            max: Point {
                x: bounds.max.x - dx,
                y: bounds.max.y - dy,
            },
        });
        'areas: for area in inner.into_iter().chain([bounds]) {
            for result in prepared.in_bounds(area) {
                // A remote reader can exhaust its discovery budget partway through.
                let Ok(f) = result else { break 'areas };
                let (Ok(rank), Ok(Some(point))) = (place_rank(f), f.point()) else {
                    break 'areas;
                };
                if best.as_ref().is_none_or(|(prev, _)| rank > *prev) {
                    best = Some((rank, point));
                }
                if !small && rank.0 == 4 && rank.1 {
                    break 'areas;
                }
            }
            if best.is_some_and(|(rank, _)| rank.0 == 4) {
                break;
            }
        }
    }
    if let Some((_, point)) = best {
        return Some(StartView {
            center: coordinates(&point),
            zoom: 15,
        });
    }
    if let Some(p) = feature_center(lib, bounds) {
        return Some(StartView {
            center: coordinates(&p),
            zoom: 15,
        });
    }
    fallback.map(|p| StartView {
        center: coordinates(&p),
        zoom: 11,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_city_node_in_the_monaco_extract() {
        let lib = Library::new(&include_bytes!("../web/data/monaco-2026-01-01.gol")[..]).unwrap();
        let q = Query::parse("n[place=city][name=Monaco]").unwrap();
        let city = lib
            .select(&q)
            .next()
            .unwrap()
            .unwrap()
            .point()
            .unwrap()
            .unwrap();
        assert_eq!(suggested_view(&lib).unwrap().center, coordinates(&city));
    }

    #[test]
    fn uses_a_feature_when_the_extract_has_no_settlements() {
        let lib = Library::new(&include_bytes!("../tests/fixtures/stress.gol")[..]).unwrap();
        let view = suggested_view(&lib).unwrap();
        assert!(
            lib.features()
                .map(Result::unwrap)
                .any(|f| { view.center == coordinates(&midpoint(f.bounds().unwrap())) })
        );
    }
}
