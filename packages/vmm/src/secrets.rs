// The secrets disk (`run --secrets FILE`): how credentials reach the guest
// without touching the kernel command line, which every process in the guest
// can read in /proc/cmdline (docs/design/microvm-runtime.md, open problem 5).
//
// The host (the CLI) writes the file, 0600, in the sandbox's run directory.
// berth-vmm attaches it as a read-only virtio-blk disk after rootfs and state
// and tells berth-init which device it is (BERTH_SECRETS_DEV). berth-init
// reads it as root before any app starts, removes the device node, and puts
// each app's entries into that app's environment only (init/src/secrets.rs).
//
// Format: the magic line, then one JSON object, then NUL padding to a whole
// number of 512-byte sectors:
//
//   BERTHSEC1\n{"shared":{"K":"V"},"apps":{"<app name>":{"K":"V"}}}\0\0...
//
// berth-vmm checks only the envelope: that the file is what the CLI writes,
// small, and private. It never parses or prints the contents.

/// The first bytes of a secrets disk. Shared with init/src/secrets.rs.
pub const MAGIC: &[u8] = b"BERTHSEC1\n";
/// The most a secrets disk may hold. Environment values, not files.
pub const MAX_BYTES: u64 = 1 << 20;
const SECTOR: u64 = 512;

/// Checks a secrets file before it is attached. The error never contains any
/// of the file's contents.
pub fn check(path: &str) -> Result<(), String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    // Not a symlink: the file must be the one the caller wrote.
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("secrets file {path}: {e}"))?;
    if !meta.file_type().is_file() {
        return Err(format!("secrets file {path} is not a regular file"));
    }
    let size = meta.len();
    if size == 0 || size > MAX_BYTES || size % SECTOR != 0 {
        return Err(format!("secrets file {path} is {size} bytes; it must be a whole number of 512-byte sectors, at most {MAX_BYTES}"));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(format!("secrets file {path} is readable by group or others (mode {:o}); it must be 0600", meta.permissions().mode() & 0o777));
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    if meta.uid() != unsafe { getuid() } {
        return Err(format!("secrets file {path} is not owned by the user running berth-vmm"));
    }
    let mut head = [0u8; MAGIC.len()];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("secrets file {path}: {e}"))?;
    if head != MAGIC {
        return Err(format!("secrets file {path} does not start with the secrets disk header"));
    }
    Ok(())
}

extern "C" {
    fn getuid() -> u32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn write(name: &str, bytes: &[u8], mode: u32) -> String {
        let dir = std::env::temp_dir().join(format!("berth-vmm-secrets-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p.display().to_string()
    }

    fn disk(json: &str) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend_from_slice(json.as_bytes());
        b.resize(b.len().div_ceil(512) * 512, 0);
        b
    }

    #[test]
    fn accepts_what_the_cli_writes() {
        assert_eq!(check(&write("ok", &disk(r#"{"shared":{},"apps":{"a":{"K":"v"}}}"#), 0o600)), Ok(()));
    }

    #[test]
    fn refuses_a_readable_file_without_quoting_it() {
        let e = check(&write("open", &disk(r#"{"shared":{"TOKEN":"hunter2"}}"#), 0o644)).unwrap_err();
        assert!(e.contains("mode 644"), "{e}");
        assert!(!e.contains("hunter2"), "{e}");
    }

    #[test]
    fn refuses_a_wrong_size_or_header() {
        assert!(check(&write("short", b"BERTHSEC1\n{}", 0o600)).unwrap_err().contains("512-byte"));
        assert!(check(&write("empty", b"", 0o600)).unwrap_err().contains("512-byte"));
        let mut other = vec![0u8; 512];
        other[..4].copy_from_slice(b"\x7fELF");
        assert!(check(&write("elf", &other, 0o600)).unwrap_err().contains("header"));
    }

    #[test]
    fn refuses_a_symlink() {
        let target = write("target", &disk("{}"), 0o600);
        let link = format!("{target}.link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(check(&link).unwrap_err().contains("not a regular file"));
    }
}
