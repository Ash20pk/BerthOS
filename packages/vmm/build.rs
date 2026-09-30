// Links against the system libkrun (Homebrew on macOS: /opt/homebrew/opt/libkrun).
// Override with LIBKRUN_LIB_DIR.
fn main() {
    let dir = std::env::var("LIBKRUN_LIB_DIR").unwrap_or_else(|_| "/opt/homebrew/opt/libkrun/lib".to_string());
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=dylib=krun");
    println!("cargo:rerun-if-env-changed=LIBKRUN_LIB_DIR");
}
