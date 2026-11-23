//! Serve the Regol Live map and query a local GOL file.
mod server;

use std::{
    env,
    error::Error,
    ffi::OsString,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::ExitCode,
};

const HELP: &str = "Usage: regol-live FILE [--bind IP] [--port PORT] [--view LON,LAT,ZOOM]
                           [--area-index DIRECTORY]

Serve the map and query an immutable local GOL file. Keep the file unchanged
while the server is running. The default address is 127.0.0.1:4173. Use port 0
to select an available port. Use --area-index for a matching named-area index.
Ctrl-C stops the server.";

struct Options {
    file: PathBuf,
    address: SocketAddr,
    view: Option<server::View>,
    area_index: Option<PathBuf>,
}

fn options(
    args: impl ExactSizeIterator<Item = OsString>,
) -> Result<Option<Options>, Box<dyn Error>> {
    let mut args = args.peekable();
    let mut file = None;
    let mut ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut port = 4173;
    let mut view = None;
    let mut area_index = None;
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .and_then(|s| s.into_string().ok())
                .ok_or_else(|| format!("expected a value for {}", arg.to_string_lossy()))
        };
        match arg.to_str() {
            Some("--help" | "-h") => {
                println!("{HELP}");
                return Ok(None);
            }
            Some("--version" | "-V") => {
                println!("regol-live {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            Some("--bind") => ip = value()?.parse()?,
            Some("--port") => port = value()?.parse()?,
            Some("--view") => view = Some(value()?.parse()?),
            Some("--area-index") => {
                area_index = Some(PathBuf::from(
                    args.next().ok_or("expected a directory for --area-index")?,
                ));
            }
            Some("--") => {
                if file.is_some() || args.len() != 1 {
                    return Err("expected one GOL file".into());
                }
                file = args.next().map(PathBuf::from);
                break;
            }
            Some(flag) if flag.starts_with('-') => {
                return Err(format!("unknown option {flag}").into());
            }
            _ if file.is_none() => file = Some(PathBuf::from(arg)),
            _ => return Err("expected one GOL file".into()),
        }
    }
    Ok(Some(Options {
        file: file.ok_or("missing GOL file (see --help)")?,
        address: SocketAddr::new(ip, port),
        view,
        area_index,
    }))
}

fn run() -> Result<(), Box<dyn Error>> {
    if let Some(options) = options(env::args_os().skip(1))? {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()?
            .block_on(server::serve(options))?;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("regol-live: {error}");
            ExitCode::FAILURE
        }
    }
}
