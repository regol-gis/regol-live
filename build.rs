use std::{env, fs, io, path::Path};

fn main() -> io::Result<()> {
    println!("cargo:rerun-if-changed=web");
    // The native UI serves the same frontend modules and vendored assets as the
    // static build. GOL data and the Wasm evaluator are only used by the latter.
    let mut assets = Vec::new();
    for directory in ["web", "web/vendor"] {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let mime = match path.extension().and_then(|value| value.to_str()) {
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("html") => "text/html; charset=utf-8",
                Some("png") => "image/png",
                Some("txt") => "text/plain",
                _ => continue,
            };
            let name = path
                .strip_prefix("web")
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            assets.push(format!(
                "({:?}, {mime:?}, include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), {:?})).as_slice()),",
                format!("/{name}"), format!("/web/{name}")
            ));
        }
    }
    assets.sort();
    let out = env::var_os("OUT_DIR").unwrap();
    fs::write(
        Path::new(&out).join("web_assets.rs"),
        format!("&[\n{}\n]", assets.join("\n")),
    )
}
