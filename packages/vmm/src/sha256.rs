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
