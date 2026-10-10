// Links against the system libkrun (Homebrew on macOS: /opt/homebrew/opt/libkrun).
// Override with LIBKRUN_LIB_DIR.
//
// Picks the pins for the target's guest architecture: a berth-vmm boots a
// guest of its own architecture, so it compiles in kernel/manifest-<arch>.toml
// and rootfs/manifest-<arch>.toml (src/pins.rs, through BERTH_GUEST_ARCH).
fn main() {
    let dir = std::env::var("LIBKRUN_LIB_DIR").unwrap_or_else(|_| "/opt/homebrew/opt/libkrun/lib".to_string());
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=dylib=krun");
    println!("cargo:rerun-if-env-changed=LIBKRUN_LIB_DIR");

    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").expect("cargo sets CARGO_CFG_TARGET_ARCH");
    for m in [format!("kernel/manifest-{arch}.toml"), format!("rootfs/manifest-{arch}.toml")] {
        if !std::path::Path::new(&m).exists() {
            panic!("no {arch} guest pins: {m} is missing (docs/design/microvm-linux.md)");
        }
    }
    println!("cargo:rustc-env=BERTH_GUEST_ARCH={arch}");
}
