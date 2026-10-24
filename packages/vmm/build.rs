// Links against the system libkrun (Homebrew on macOS: /opt/homebrew/opt/libkrun).
// Override with LIBKRUN_LIB_DIR. The binary also looks next to itself (RUNPATH
// $ORIGIN on Linux, LC_RPATH @loader_path on macOS): the published berth-vmm
// ships with its own libkrun, installed beside it in ~/.berth/vm/bin, so no
// system package is needed and the version doctor checks is the one it was
// tested with. On macOS that takes a libkrun whose install name is
// @rpath/libkrun.1.dylib (vm-artifacts sets it); Homebrew's has an absolute
// one, so a local build keeps linking the keg.
//
// Picks the pins for the target's guest architecture: a berth-vmm boots a
// guest of its own architecture, so it compiles in kernel/manifest-<arch>.toml
// and rootfs/manifest-<arch>.toml (src/pins.rs, through BERTH_GUEST_ARCH).
fn main() {
    let dir = std::env::var("LIBKRUN_LIB_DIR").unwrap_or_else(|_| "/opt/homebrew/opt/libkrun/lib".to_string());
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=dylib=krun");
    println!("cargo:rerun-if-env-changed=LIBKRUN_LIB_DIR");
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN"),
        Ok("macos") => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@loader_path"),
        _ => {}
    }

    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").expect("cargo sets CARGO_CFG_TARGET_ARCH");
    for m in [format!("kernel/manifest-{arch}.toml"), format!("rootfs/manifest-{arch}.toml")] {
        if !std::path::Path::new(&m).exists() {
            panic!("no {arch} guest pins: {m} is missing (docs/design/microvm-linux.md)");
        }
    }
    println!("cargo:rustc-env=BERTH_GUEST_ARCH={arch}");
}
