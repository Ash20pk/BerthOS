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
//  - An optional layer (docs/design/microvm-layers.md) is pinned in the rootfs
//    manifest (layer_<name>_sha256/_size/_base) and boots only on the base it
//    was built for: its files are laid over that base's, read-only.
use crate::sha256;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

pub const KERNEL_MANIFEST: &str = include_str!("../kernel/manifest.toml");
/// The base rootfs this berth-vmm was released with (`berth-vmm run`'s
/// default). Any content-addressed image still boots with --rootfs; the
/// measurement line says whether it was this one.
pub const ROOTFS_MANIFEST: &str = include_str!("../rootfs/manifest.toml");

pub fn kernel_pin() -> &'static str {
    manifest_get(KERNEL_MANIFEST, "image_sha256").expect("kernel manifest has image_sha256")
}

pub fn rootfs_pin() -> &'static str {
    manifest_get(ROOTFS_MANIFEST, "image_sha256").expect("rootfs manifest has image_sha256")
}

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

/// `block_root`: the root is the rootfs image (`cmdline`, berth-init as PID 1
/// straight from the kernel); otherwise a virtio-fs directory
/// (`cmdline_virtiofs_root`, through libkrun's init.krun).
pub fn verify_kernel(path: &str, block_root: bool) -> Result<Kernel, String> {
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
        cmdline: need(if block_root { "cmdline" } else { "cmdline_virtiofs_root" })?.into(),
        linux: need("linux_version")?.into(),
        config_sha256: need("config_sha256")?.into(),
        hash_ms,
    })
}

/// A layer this berth-vmm will attach: its pin, and the base rootfs it was built for.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerPin {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub base: String,
}

pub fn layer_pin(name: &str) -> Option<LayerPin> {
    layer_pin_in(ROOTFS_MANIFEST, name)
}

pub fn layer_pin_in(manifest: &str, name: &str) -> Option<LayerPin> {
    let get = |k: &str| manifest_get(manifest, &format!("layer_{name}_{k}"));
    let sha256 = get("sha256").filter(|s| is_hex64(s))?.to_string();
    let base = get("base").filter(|s| is_hex64(s))?.to_string();
    let size = get("size")?.parse().ok()?;
    Some(LayerPin { name: name.into(), sha256, size, base })
}

/// The layers pinned in this berth-vmm's rootfs manifest, by name.
pub fn layer_names() -> Vec<String> {
    ROOTFS_MANIFEST
        .lines()
        .filter_map(|l| l.split_once('=').map(|(k, _)| k.trim()))
        .filter_map(|k| k.strip_prefix("layer_").and_then(|r| r.strip_suffix("_sha256")))
        .filter(|n| layer_pin(n).is_some())
        .map(String::from)
        .collect()
}

pub struct Layer {
    pub name: String,
    pub path: String,
    pub sha256: String,
    pub hash_ms: u128,
}

/// Checks a layer image against its pin, and that it was built for the base
/// being booted: a layer's libraries are linked against that base's.
pub fn verify_layer(name: &str, path: &str, booted_rootfs: &str) -> Result<Layer, String> {
    let pin = layer_pin(name).ok_or_else(|| format!("no layer {name:?} is pinned in this berth-vmm (rootfs/manifest.toml has {:?})", layer_names()))?;
    if pin.base != booted_rootfs {
        return Err(format!("layer {name} was built for rootfs {}, not the {} being booted; refusing to attach it", &pin.base[..12], &booted_rootfs[..12.min(booted_rootfs.len())]));
    }
    let t = Instant::now();
    let got = sha256::hex(&sha256::file(path).map_err(|e| format!("cannot read layer {path}: {e}"))?);
    let hash_ms = t.elapsed().as_millis();
    if got != pin.sha256 {
        return Err(format!("layer {path} has sha256 {got}, but layer {name} is pinned to {}; refusing to attach it", pin.sha256));
    }
    if fstype_of(path)? != "erofs" {
        return Err(format!("layer {path} is not an erofs image"));
    }
    Ok(Layer { name: name.into(), path: path.into(), sha256: got, hash_ms })
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
    /// Bytes added back to a disk the last run left shorter than --state-size.
    pub restored: u64,
    /// sha256::chunked_sparse of the disk as this boot starts from it.
    pub digest: String,
    pub hash_ms: u128,
    pub hashed_bytes: u64,
}

/// The state disk's chunk size for its digest (sha256::chunked_sparse).
pub const STATE_DIGEST_CHUNK: u64 = 1 << 20;

/// What the sandbox boots from on its writable disk, by content: taken after
/// any size restore, before the VM can write. A new disk is all zeros.
fn measure_state(mut s: State) -> Result<State, String> {
    let t = Instant::now();
    let (d, read) = sha256::chunked_sparse(&s.path, STATE_DIGEST_CHUNK).map_err(|e| format!("cannot hash state disk {}: {e}", s.path))?;
    s.hash_ms = t.elapsed().as_millis();
    s.digest = sha256::hex(&d);
    s.hashed_bytes = read;
    Ok(s)
}

/// Opens the sandbox's state disk, creating it sparse at `size_mib` on first
/// use. The guest formats it (ext4) on first boot. A larger existing disk
/// keeps its size (reported, not shrunk).
///
/// A shorter one is extended back to `size_mib`. libkrun 1.19.6 on macOS
/// truncates a raw image when the guest discards or write-zeroes a range that
/// reaches its end (mkfs.ext4 zeroes the last blocks; `blkdiscard /dev/vdb`
/// truncates the file to 0), so the next boot would see a smaller device than
/// the filesystem on it and the mount fails with EINVAL. The truncated tail is
/// a range the guest asked to read as zeros, so re-extending it with a sparse
/// zero tail is the correct content, not a guess.
pub fn open_state(path: &str, size_mib: u64) -> Result<State, String> {
    open_state_unmeasured(path, size_mib).and_then(measure_state)
}

fn new_state(path: &str, size: u64, created: bool, restored: u64) -> State {
    State { path: path.into(), size, created, restored, digest: String::new(), hash_ms: 0, hashed_bytes: 0 }
}

fn open_state_unmeasured(path: &str, size_mib: u64) -> Result<State, String> {
    let want = size_mib * 1024 * 1024;
    match OpenOptions::new().read(true).write(true).create_new(true).open(path) {
        Ok(f) => {
            f.set_len(want).map_err(|e| format!("cannot size state disk {path}: {e}"))?;
            Ok(new_state(path, want, true, 0))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut f = OpenOptions::new().read(true).write(true).open(path).map_err(|e| format!("cannot open state disk {path}: {e}"))?;
            let size = f.seek(SeekFrom::End(0)).map_err(|e| format!("cannot size state disk {path}: {e}"))?;
            if size < want {
                f.set_len(want).map_err(|e| format!("cannot restore state disk {path} to {want} bytes: {e}"))?;
                eprintln!("berth-vmm: state disk {path} was {size} bytes, restored to {want} (libkrun truncates on a tail discard)");
                return Ok(new_state(path, want, false, want - size));
            }
            if size > want {
                eprintln!("berth-vmm: state disk {path} is {} MiB; keeping it (larger than --state-size {size_mib})", size >> 20);
            }
            Ok(new_state(path, size, false, 0))
        }
        Err(e) => Err(format!("cannot create state disk {path}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_pins_from_the_manifest() {
        let m = format!("image_sha256 = \"{}\"\nlayer_example_sha256 = \"{}\"\nlayer_example_size = 471040\nlayer_example_base = \"{}\"\nlayer_bad_sha256 = \"nothex\"\n", "a".repeat(64), "b".repeat(64), "a".repeat(64));
        let p = layer_pin_in(&m, "example").unwrap();
        assert_eq!((p.sha256.as_str(), p.size, p.base.as_str()), ("b".repeat(64).as_str(), 471040, "a".repeat(64).as_str()));
        assert!(layer_pin_in(&m, "bad").is_none());
        assert!(layer_pin_in(&m, "missing").is_none());
    }

    #[test]
    fn manifest_has_what_berth_vmm_needs() {
        assert!(is_hex64(rootfs_pin()));
        for k in ["image_sha256", "image_format", "cmdline", "linux_version", "config_sha256"] {
            assert!(manifest_get(KERNEL_MANIFEST, k).is_some(), "{k}");
        }
        assert!(is_hex64(manifest_get(KERNEL_MANIFEST, "image_sha256").unwrap()));
        for key in ["cmdline", "cmdline_virtiofs_root"] {
            let cmdline = manifest_get(KERNEL_MANIFEST, key).unwrap_or_else(|| panic!("{key}"));
            assert!(!cmdline.contains("lsm="), "the LSM list is compiled in; the cmdline must not override it");
        }
        // The sandbox boots the rootfs image as the kernel's root, berth-init
        // as PID 1, and nothing from libkrun in between.
        let c = manifest_get(KERNEL_MANIFEST, "cmdline").unwrap();
        for want in ["root=/dev/vda", "rootfstype=erofs", " ro ", "init=/sbin/berth-init"] {
            assert!(c.contains(want), "cmdline lacks {want:?}");
        }
        assert!(!c.contains("init.krun"));
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
