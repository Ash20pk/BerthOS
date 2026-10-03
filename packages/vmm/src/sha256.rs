// SHA-256 of a file, with no crate dependencies.
//
// On macOS this is CommonCrypto (libSystem, hardware-accelerated, ~2 GB/s on
// Apple silicon); elsewhere a portable implementation. Both are checked
// against known vectors in the tests below.
use std::fs::File;
use std::io::{self, Read};

pub fn hex(d: &[u8; 32]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn file(path: &str) -> io::Result<[u8; 32]> {
    let mut f = File::open(path)?;
    let mut h = Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finish())
}

/// Digest of a (usually sparse) disk image's logical content, whose cost is
/// proportional to the data in it rather than its size: the image is split
/// into `chunk`-byte chunks, each is hashed (a chunk holding no data at all is
/// all zeros, so its hash is known without reading it), and the result is
///
///   SHA-256("berth-chunked-sha256-v1\0" || u64be(size) || u64be(chunk) || H(c0) || H(c1) || ...)
///
/// A function of the bytes alone: the same content gives the same digest
/// however the file happens to be allocated. Returns (digest, bytes read).
pub fn chunked_sparse(path: &str, chunk: u64) -> io::Result<([u8; 32], u64)> {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::io::AsRawFd;
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let n = size.div_ceil(chunk);
    let mut data = vec![false; n as usize];
    match data_extents(f.as_raw_fd(), size) {
        Some(extents) => {
            for (start, end) in extents {
                for c in start / chunk..end.div_ceil(chunk).min(n) {
                    data[c as usize] = true;
                }
            }
        }
        None => data.iter_mut().for_each(|d| *d = true),
    }
    let zero_hash = |len: u64| {
        let mut h = Hasher::new();
        let z = vec![0u8; len as usize];
        h.update(&z);
        h.finish()
    };
    let full_zero = zero_hash(chunk.min(size));
    let mut outer = Hasher::new();
    outer.update(b"berth-chunked-sha256-v1\0");
    outer.update(&size.to_be_bytes());
    outer.update(&chunk.to_be_bytes());
    let mut buf = vec![0u8; chunk as usize];
    let mut read = 0u64;
    for c in 0..n {
        let len = chunk.min(size - c * chunk);
        let h = if data[c as usize] {
            f.seek(SeekFrom::Start(c * chunk))?;
            f.read_exact(&mut buf[..len as usize])?;
            read += len;
            let mut h = Hasher::new();
            h.update(&buf[..len as usize]);
            h.finish()
        } else if len == chunk.min(size) {
            full_zero
        } else {
            zero_hash(len)
        };
        outer.update(&h);
    }
    Ok((outer.finish(), read))
}

/// The file's data extents, from lseek(SEEK_DATA/SEEK_HOLE); None if the
/// filesystem cannot tell (then every chunk is read).
fn data_extents(fd: i32, size: u64) -> Option<Vec<(u64, u64)>> {
    extern "C" {
        fn lseek(fd: i32, offset: i64, whence: i32) -> i64;
    }
    #[cfg(target_os = "macos")]
    const SEEK_HOLE_DATA: (i32, i32) = (3, 4);
    #[cfg(not(target_os = "macos"))]
    const SEEK_HOLE_DATA: (i32, i32) = (4, 3);
    let (seek_hole, seek_data) = SEEK_HOLE_DATA;
    let mut out = Vec::new();
    let mut pos = 0i64;
    while (pos as u64) < size {
        let start = unsafe { lseek(fd, pos, seek_data) };
        if start < 0 {
            // ENXIO: no data after pos. Anything else: unsupported.
            return if io::Error::last_os_error().raw_os_error() == Some(6) { Some(out) } else { None };
        }
        let end = unsafe { lseek(fd, start, seek_hole) };
        if end < 0 {
            return None;
        }
        out.push((start as u64, end as u64));
        pos = end;
    }
    Some(out)
}

#[cfg(target_os = "macos")]
mod imp {
    // CC_SHA256_CTX is 26 u32s (count[2], hash[8], wbuf[16]); leave headroom.
    #[repr(C)]
    pub struct Ctx([u32; 32]);
    extern "C" {
        fn CC_SHA256_Init(c: *mut Ctx) -> i32;
        fn CC_SHA256_Update(c: *mut Ctx, data: *const u8, len: u32) -> i32;
        fn CC_SHA256_Final(md: *mut u8, c: *mut Ctx) -> i32;
    }
    pub struct Hasher(Box<Ctx>);
    impl Hasher {
        pub fn new() -> Self {
            let mut c = Box::new(Ctx([0; 32]));
            unsafe { CC_SHA256_Init(&mut *c) };
            Hasher(c)
        }
        pub fn update(&mut self, data: &[u8]) {
            for chunk in data.chunks(u32::MAX as usize) {
                unsafe { CC_SHA256_Update(&mut *self.0, chunk.as_ptr(), chunk.len() as u32) };
            }
        }
        pub fn finish(mut self) -> [u8; 32] {
            let mut out = [0u8; 32];
            unsafe { CC_SHA256_Final(out.as_mut_ptr(), &mut *self.0) };
            out
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub use super::portable::Hasher;
}

#[allow(dead_code)]
mod portable {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
        0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
        0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
        0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
        0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    pub struct Hasher {
        h: [u32; 8],
        buf: [u8; 64],
        len: usize,
        total: u64,
    }

    impl Hasher {
        pub fn new() -> Self {
            Hasher {
                h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
                buf: [0; 64],
                len: 0,
                total: 0,
            }
        }

        fn block(&mut self, b: &[u8]) {
            let mut w = [0u32; 64];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
            }
            let [mut a, mut b_, mut c, mut d, mut e, mut f, mut g, mut h] = self.h;
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ (!e & g);
                let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b_) ^ (a & c) ^ (b_ & c);
                let t2 = s0.wrapping_add(maj);
                h = g;
                g = f;
                f = e;
                e = d.wrapping_add(t1);
                d = c;
                c = b_;
                b_ = a;
                a = t1.wrapping_add(t2);
            }
            for (s, v) in self.h.iter_mut().zip([a, b_, c, d, e, f, g, h]) {
                *s = s.wrapping_add(v);
            }
        }

        pub fn update(&mut self, mut data: &[u8]) {
            self.total += data.len() as u64;
            if self.len > 0 {
                let take = (64 - self.len).min(data.len());
                self.buf[self.len..self.len + take].copy_from_slice(&data[..take]);
                self.len += take;
                data = &data[take..];
                if self.len == 64 {
                    let b = self.buf;
                    self.block(&b);
                    self.len = 0;
                }
            }
            while data.len() >= 64 {
                self.block(&data[..64]);
                data = &data[64..];
            }
            self.buf[..data.len()].copy_from_slice(data);
            self.len = data.len();
        }

        pub fn finish(mut self) -> [u8; 32] {
            let bits = self.total.wrapping_mul(8);
            let mut pad = vec![0x80u8];
            while (self.len + pad.len()) % 64 != 56 {
                pad.push(0);
            }
            pad.extend_from_slice(&bits.to_be_bytes());
            let total = self.total;
            self.update(&pad);
            self.total = total;
            let mut out = [0u8; 32];
            for (i, v) in self.h.iter().enumerate() {
                out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
            }
            out
        }
    }
}

pub use imp::Hasher;

/// A directory tree's digest: the sha256 of its `<sha256>  <relative path>`
/// lines, one per regular file, sorted by path (the form the rootfs manifest's
/// sdk_python_sha256 uses). A symlink is a line too, `-> <target>` in place of
/// the hash, so retargeting one changes the digest; anything else (sockets,
/// devices) is refused. Returns (digest, files, bytes).
pub fn tree(dir: &str) -> io::Result<([u8; 32], u64, u64)> {
    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>, bytes: &mut u64) -> io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let rel = path.strip_prefix(root).map_err(|e| io::Error::other(e.to_string()))?.to_string_lossy().into_owned();
            let ty = entry.file_type()?;
            if ty.is_symlink() {
                out.push((rel, format!("-> {}", std::fs::read_link(&path)?.to_string_lossy())));
            } else if ty.is_dir() {
                walk(root, &path, out, bytes)?;
            } else if ty.is_file() {
                *bytes += entry.metadata()?.len();
                out.push((rel, hex(&file(&path.to_string_lossy())?)));
            } else {
                return Err(io::Error::other(format!("{rel} is not a file, directory or symlink")));
            }
        }
        Ok(())
    }
    let root = std::path::Path::new(dir);
    let mut lines = Vec::new();
    let mut bytes = 0;
    walk(root, root, &mut lines, &mut bytes)?;
    lines.sort();
    let mut h = Hasher::new();
    for (rel, sum) in &lines {
        h.update(format!("{sum}  {rel}\n").as_bytes());
    }
    Ok((h.finish(), lines.len() as u64, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &[(&str, &str)] = &[
        ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        (
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
    ];

    #[test]
    fn tree_digest_follows_names_and_contents() {
        let base = std::env::temp_dir().join(format!("berth-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("dist")).unwrap();
        std::fs::write(base.join("berth.yml"), "name: a\n").unwrap();
        std::fs::write(base.join("dist/index.mjs"), "x").unwrap();
        let d = |p: &std::path::Path| tree(&p.to_string_lossy()).unwrap();
        let (a, files, bytes) = d(&base);
        assert_eq!((files, bytes), (2, 9));
        // The same as hashing the listing by hand.
        let mut h = Hasher::new();
        h.update(format!("{}  berth.yml\n{}  dist/index.mjs\n", hex(&file(&base.join("berth.yml").to_string_lossy()).unwrap()), hex(&file(&base.join("dist/index.mjs").to_string_lossy()).unwrap())).as_bytes());
        assert_eq!(a, h.finish());
        std::fs::write(base.join("dist/index.mjs"), "y").unwrap();
        assert_ne!(d(&base).0, a, "a changed file changes the digest");
        std::fs::write(base.join("dist/index.mjs"), "x").unwrap();
        assert_eq!(d(&base).0, a);
        std::fs::rename(base.join("dist/index.mjs"), base.join("dist/other.mjs")).unwrap();
        assert_ne!(d(&base).0, a, "a renamed file changes it");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn known_vectors_both_impls() {
        for (input, want) in VECTORS {
            let mut a = Hasher::new();
            a.update(input.as_bytes());
            assert_eq!(hex(&a.finish()), *want);
            let mut b = portable::Hasher::new();
            b.update(input.as_bytes());
            assert_eq!(hex(&b.finish()), *want);
        }
    }

    #[test]
    fn chunked_sparse_ignores_allocation() {
        use std::io::{Seek, SeekFrom, Write};
        let dir = std::env::temp_dir();
        let (a, b) = (dir.join(format!("berth-cs-a-{}", std::process::id())), dir.join(format!("berth-cs-b-{}", std::process::id())));
        // a: sparse 3 MiB + 5 bytes with data in the middle; b: the same bytes, fully written.
        let size = 3 * 1024 * 1024 + 5;
        let mut fa = File::create(&a).unwrap();
        fa.set_len(size).unwrap();
        fa.seek(SeekFrom::Start(1_500_000)).unwrap();
        fa.write_all(b"state").unwrap();
        let mut content = vec![0u8; size as usize];
        content[1_500_000..1_500_005].copy_from_slice(b"state");
        File::create(&b).unwrap().write_all(&content).unwrap();
        let (da, ra) = chunked_sparse(a.to_str().unwrap(), 1 << 20).unwrap();
        let (db, rb) = chunked_sparse(b.to_str().unwrap(), 1 << 20).unwrap();
        assert_eq!(da, db);
        assert!(ra <= rb);
        // One byte different, different digest.
        content[size as usize - 1] = 1;
        File::create(&b).unwrap().write_all(&content).unwrap();
        assert_ne!(chunked_sparse(b.to_str().unwrap(), 1 << 20).unwrap().0, da);
        let _ = (std::fs::remove_file(a), std::fs::remove_file(b));
    }

    #[test]
    fn chunked_equals_whole() {
        let data: Vec<u8> = (0..100_003u32).map(|i| (i * 31 % 251) as u8).collect();
        let mut whole = portable::Hasher::new();
        whole.update(&data);
        let whole = whole.finish();
        let mut parts = portable::Hasher::new();
        for c in data.chunks(97) {
            parts.update(c);
        }
        assert_eq!(parts.finish(), whole);
        let mut native = Hasher::new();
        native.update(&data);
        assert_eq!(native.finish(), whole);
    }
}
