const COMMANDS: &[&str] = &[
    "save_to_downloads",
    "secure_set",
    "secure_get",
    "secure_delete",
    "print_pdf",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
