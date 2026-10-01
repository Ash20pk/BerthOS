// What berth-vmm is willing to boot, and how it checks it.
//
//  - The kernel is pinned: kernel/manifest.toml is compiled into the binary,
//    and a --kernel whose sha256 differs from the manifest's image_sha256 is
//    refused. The command line comes from the manifest as well.
//  - The root filesystem is content-addressed: its sha256 is its name
//    (rootfs-<sha256>.erofs) or is passed with --rootfs-sha256, and the image
//    must hash to it.
//  - The state disk is the sandbox's own: created sparse on first use, with a
//    fixed size that is its cap.
use crate::sha256;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

pub const KERNEL_MANIFEST: &str = include_str!("../kernel/manifest.toml");

/// Value of a flat `key = "value"` / `key = 123` line.
pub fn manifest_get<'a>(manifest: &'a str, key: &str) -> Option<&'a str> {
    manifest.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        Some(v.trim().trim_matches('"'))
    })
}

pub struct Kernel {
    pub path: String,
    pub sha256: String,
    pub format: u32,
    pub cmdline: String,
    pub linux: String,
    pub config_sha256: String,
    pub hash_ms: u128,
}

fn kernel_format(name: &str) -> Result<u32, String> {
    match name {
        "raw" => Ok(0),
        "elf" => Ok(1),
        "image_gz" => Ok(4),
        other => Err(format!("kernel manifest: unknown image_format {other:?}")),
    }
}

pub fn verify_kernel(path: &str) -> Result<Kernel, String> {
    let m = KERNEL_MANIFEST;
    let need = |k: &str| manifest_get(m, k).ok_or_else(|| format!("kernel manifest has no {k}"));
    let want = need("image_sha256")?;
    let t = Instant::now();
    let got = sha256::file(path).map_err(|e| format!("cannot read kernel {path}: {e}"))?;
    let hash_ms = t.elapsed().as_millis();
    let got = sha256::hex(&got);
    if got != want {
        return Err(format!(
            "kernel {path} has sha256 {got}, but this berth-vmm is pinned to {want} \
             (linux {}, kernel/manifest.toml); refusing to boot it",
            manifest_get(m, "linux_version").unwrap_or("?")
        ));
    }
    Ok(Kernel {
        path: path.into(),
        sha256: got,
        format: kernel_format(need("image_format")?)?,
        cmdline: need("cmdline")?.into(),
        linux: need("linux_version")?.into(),
        config_sha256: need("config_sha256")?.into(),
        hash_ms,
    })
}

pub struct Rootfs {
    pub path: String,
    pub sha256: String,
    pub fstype: &'static str,
    pub hash_ms: u128,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The sha256 a content-addressed file name carries: `<anything>-<hex64>.<ext>`
/// or `<hex64>.<ext>` or `<hex64>`.
pub fn sha_from_name(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let stem = name.split('.').next()?;
    let tail = stem.rsplit('-').next()?;
    is_hex64(tail).then(|| tail.to_string())
}

/// Superblock magic: erofs at 1024 (0xE0F5E1E2 LE), ext2/3/4 at 1080 (0xEF53 LE).
fn fstype_of(path: &str) -> Result<&'static str, String> {
    let mut f = File::open(path).map_err(|e| format!("cannot open rootfs {path}: {e}"))?;
    let mut sb = [0u8; 2048];
    f.read_exact(&mut sb).map_err(|e| format!("rootfs {path} too small: {e}"))?;
    if sb[1024..1028] == [0xe2, 0xe1, 0xf5, 0xe0] {
        Ok("erofs")
    } else if sb[1080..1082] == [0x53, 0xef] {
        Ok("ext4")
    } else {
        Err(format!("rootfs {path} is neither erofs nor ext4"))
    }
}

pub fn verify_rootfs(path: &str, expected: Option<&str>) -> Result<Rootfs, String> {
    let want = match expected {
        Some(s) if is_hex64(s) => s.to_string(),
        Some(s) => return Err(format!("--rootfs-sha256 {s:?} is not a lowercase hex sha256")),
        None => sha_from_name(path).ok_or_else(|| {
            format!("rootfs {path} is not content-addressed: name it <name>-<sha256>.erofs or pass --rootfs-sha256")
        })?,
    };
    // Probed once, here, before the guest can write anything: the image is
    // attached read-only and always as raw (see libkrun's krun_add_disk2 note).
    let fstype = fstype_of(path)?;
    let t = Instant::now();
    let got = sha256::hex(&sha256::file(path).map_err(|e| format!("cannot read rootfs {path}: {e}"))?);
    let hash_ms = t.elapsed().as_millis();
    if got != want {
        return Err(format!("rootfs {path} has sha256 {got}, expected {want}; refusing to boot it"));
    }
    Ok(Rootfs { path: path.into(), sha256: got, fstype, hash_ms })
}

pub struct State {
    pub path: String,
    pub size: u64,
    pub created: bool,
}

/// Opens the sandbox's state disk, creating it sparse at `size_mib` on first
/// use. The guest formats it (ext4) on first boot. An existing disk keeps its
/// size; a different --state-size is reported, not applied.
pub fn open_state(path: &str, size_mib: u64) -> Result<State, String> {
    let want = size_mib * 1024 * 1024;
    match OpenOptions::new().read(true).write(true).create_new(true).open(path) {
        Ok(f) => {
            f.set_len(want).map_err(|e| format!("cannot size state disk {path}: {e}"))?;
            Ok(State { path: path.into(), size: want, created: true })
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut f = OpenOptions::new().read(true).write(true).open(path).map_err(|e| format!("cannot open state disk {path}: {e}"))?;
            let size = f.seek(SeekFrom::End(0)).map_err(|e| format!("cannot size state disk {path}: {e}"))?;
            if size != want {
                eprintln!("berth-vmm: state disk {path} is {} MiB; keeping it (--state-size {size_mib} is only applied on creation)", size >> 20);
            }
            Ok(State { path: path.into(), size, created: false })
        }
        Err(e) => Err(format!("cannot create state disk {path}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_what_berth_vmm_needs() {
        for k in ["image_sha256", "image_format", "cmdline", "linux_version", "config_sha256"] {
            assert!(manifest_get(KERNEL_MANIFEST, k).is_some(), "{k}");
        }
        assert!(is_hex64(manifest_get(KERNEL_MANIFEST, "image_sha256").unwrap()));
        let cmdline = manifest_get(KERNEL_MANIFEST, "cmdline").unwrap();
        assert!(!cmdline.contains("lsm="), "the LSM list is compiled in; the cmdline must not override it");
    }

    #[test]
    fn content_addressed_names() {
        let h = "8f79e8dae97ebc0ab8fcdc4ad209bb025ec967be82c713503e0612cfdd340ec8";
        assert_eq!(sha_from_name(&format!("/a/b/rootfs-{h}.erofs")).as_deref(), Some(h));
        assert_eq!(sha_from_name(&format!("/a/{h}.erofs")).as_deref(), Some(h));
        assert_eq!(sha_from_name("/a/rootfs.erofs"), None);
        assert_eq!(sha_from_name(&format!("/a/rootfs-{}.erofs", h.to_uppercase())), None);
    }
}
