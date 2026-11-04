fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "print_receipt",
            "print_raw_text",
            "open_cash_drawer",
            "test_print",
            "get_print_jobs",
            "get_print_job",
            "list_printers",
            "get_runtime_config",
            "write_log",
        ])),
    )
    .expect("tauri build")
}
