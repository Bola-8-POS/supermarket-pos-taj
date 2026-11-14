//! `posctl.exe`: thin shell over the library. All behaviour is in `posctl::cli`.
//! Must never: hold logic or secrets, or print anything but the one JSON object `run_cli` writes.

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let code = posctl::cli::run_cli(args, &mut std::io::stdin(), &mut std::io::stdout());
    std::process::exit(code);
}
