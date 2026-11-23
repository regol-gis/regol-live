use regol::{
    DictionaryLoading, Library, Limits, Predicate, Query, Selector, Types, source::MappedFile,
    units::angle::radian,
};
use std::{
    env,
    error::Error,
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

// The hosted index builder supplies one batch in memory. Coordinates and tags
// used here are stored on the feature's own tile, including way coordinates.
fn planet_candidates() -> Result<(), Box<dyn Error>> {
    let mut bytes = Vec::new();
    let limit = 512 * 1024 * 1024;
    io::stdin().lock().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err("planet tile batch exceeds 512 MiB".into());
    }
    let library = Library::new(bytes.as_slice())?;
    let query =
        Query::new(Selector::new(Types::WAY.union(Types::AREA)).and(Predicate::present("name")));
    let mut out = BufWriter::new(io::stdout().lock());
    for feature in query.prepare(&library)?.iter() {
        let feature = feature?;
        if !feature.is_area() {
            let mut points = feature.coordinates()?;
            let Some(first) = points.next().transpose()? else {
                continue;
            };
            let mut last = first;
            let mut count = 1;
            for point in points {
                last = point?;
                count += 1;
            }
            if count < 4 || first != last {
                continue;
            }
        }
        let bounds = feature.bounds()?;
        let sw = bounds.min.lon_lat();
        let ne = bounds.max.lon_lat();
        // Area of the geographic bounding rectangle on a sphere, in km².
        // It is intentionally conservative for thin or multipart features.
        let km2 = 6371.0088_f64.powi(2)
            * (ne.longitude.get::<radian>() - sw.longitude.get::<radian>())
            * (ne.latitude.get::<radian>().sin() - sw.latitude.get::<radian>().sin());
        let boundary = feature
            .tag("boundary")?
            .is_some_and(|value| value.to_string() == "administrative");
        let place = feature.tag("place")?.is_some_and(|value| {
            matches!(
                value.to_string().as_str(),
                "neighbourhood"
                    | "quarter"
                    | "suburb"
                    | "borough"
                    | "city_district"
                    | "city"
                    | "town"
                    | "village"
                    | "hamlet"
                    | "municipality"
                    | "isolated_dwelling"
            )
        });
        let name = feature.tag("name")?.ok_or("missing name")?.to_string();
        serde_json::to_writer(
            &mut out,
            &(
                regol_overpass::named_area::shard(&name),
                name,
                bounds.min.x,
                bounds.min.y,
                km2,
                boundary || place,
            ),
        )?;
        out.write_all(b"\n")?;
    }
    out.flush()?;
    Ok(())
}

const USAGE: &str =
    "Usage: regol-area-index GOL OUTPUT_DIR\n\nKeep the GOL immutable during generation.";

fn build(gol: &Path, output: &Path) -> Result<(), Box<dyn Error>> {
    // SAFETY: the CLI requires the GOL to remain immutable throughout the scan.
    let source = unsafe { MappedFile::open(gol)? };
    let library =
        Library::with_dictionary_loading(source, Limits::default(), DictionaryLoading::OnDemand)?;
    regol_overpass::area_index::build(&library, output)
}

fn run() -> Result<(), Box<dyn Error>> {
    let paths: Vec<_> = env::args_os().skip(1).map(PathBuf::from).collect();
    match paths.as_slice() {
        [mode] if mode == Path::new("--planet-candidates") => planet_candidates(),
        [help] if help == Path::new("--help") || help == Path::new("-h") => {
            println!("{USAGE}");
            Ok(())
        }
        [gol, output] => build(gol, output),
        _ => Err(USAGE.into()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("regol-area-index: {error}");
            ExitCode::FAILURE
        }
    }
}
