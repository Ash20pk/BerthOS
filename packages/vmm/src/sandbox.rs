// The host-side wall around berth-vmm itself (open problem 9 in
// docs/design/microvm-runtime.md).
//
// libkrun runs the VMM and the guest as one security context: what this
// process can reach on the host is what a guest that escaped the VM could
// reach. So `berth-vmm run` confines itself with a Seatbelt profile built for
// this one sandbox, applied just before krun_start_enter, once everything that
// needs wider access (hashing the kernel and rootfs, creating the state disk,
// binding the run directory's sockets, starting the egress dialer) is done:
//
//   read          the kernel, the rootfs image, each app share, the secrets disk
//   read + write  the state disk and the run directory (sockets, console.log)
//   network       Unix sockets under the run directory; with the egress dialer,
//                 outbound TCP too (the dialer enforces the allowlist itself,
//                 and Seatbelt cannot filter by host name)
//   everything else of the user's: denied
//
// plus what any process needs to run (system libraries, Homebrew's libkrun,
// dyld's cache) and what Hypervisor.framework needs. The spike's static
// berth-vmm.sb is where these baseline rules were found to be enough.
use std::os::raw::{c_char, c_int};

/// What one sandbox may touch. Paths must already be canonical (Seatbelt
/// matches the real path: /private/var, not /var).
#[derive(Debug, Default)]
pub struct Plan {
    pub read_files: Vec<String>,
    pub read_dirs: Vec<String>,
    pub write_files: Vec<String>,
    pub write_dirs: Vec<String>,
    /// The directory whose Unix sockets berth-vmm binds and accepts on.
    pub socket_dir: String,
    /// The egress dialer runs: outbound TCP and name resolution.
    pub egress: bool,
}

/// A Scheme string literal for SBPL.
fn q(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            _ => o.push(c),
        }
    }
    o.push('"');
    o
}

pub fn profile(p: &Plan) -> String {
    let lit = |v: &[String]| v.iter().map(|s| format!("(literal {})", q(s))).collect::<Vec<_>>().join(" ");
    let sub = |v: &[String]| v.iter().map(|s| format!("(subpath {})", q(s))).collect::<Vec<_>>().join(" ");
    let mut o = String::from(
        r#"(version 1)
(deny default)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow iokit-open)
(allow file-read* file-map-executable
    (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db/dyld")
    (subpath "/Library/Apple") (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Cellar"))
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))
(allow file-write* (literal "/dev/null"))
"#,
    );
    if !p.read_files.is_empty() {
        o.push_str(&format!("(allow file-read* {})\n", lit(&p.read_files)));
    }
    if !p.read_dirs.is_empty() {
        o.push_str(&format!("(allow file-read* {})\n", sub(&p.read_dirs)));
    }
    if !p.write_files.is_empty() {
        o.push_str(&format!("(allow file-read* file-write* {})\n", lit(&p.write_files)));
    }
    if !p.write_dirs.is_empty() {
        o.push_str(&format!("(allow file-read* file-write* {})\n", sub(&p.write_dirs)));
    }
    let sd = q(&p.socket_dir);
    o.push_str(&format!(
        "(allow network-bind network-inbound network-outbound (local unix-socket (subpath {sd})) (remote unix-socket (subpath {sd})))\n"
    ));
    if p.egress {
        // The dialer resolves names itself: getaddrinfo asks mDNSResponder,
        // over its Unix socket, and reads these files.
        o.push_str("(allow file-read* (literal \"/private/etc/hosts\") (literal \"/private/etc/resolv.conf\") (literal \"/private/var/run/resolv.conf\"))\n");
        o.push_str("(allow network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n");
        o.push_str("(allow network-outbound (remote tcp))\n");
    }
    o
}

#[cfg(target_os = "macos")]
extern "C" {
    // libsystem_sandbox, part of libSystem. Not in the public headers, but
    // stable for well over a decade (Chromium's and WebKit's sandboxes call it).
    fn sandbox_init_with_parameters(profile: *const c_char, flags: u64, parameters: *const *const c_char, errorbuf: *mut *mut c_char) -> c_int;
    fn sandbox_free_error(errorbuf: *mut c_char);
}

/// Confines this process, for good, with `profile`.
#[cfg(target_os = "macos")]
pub fn apply(profile: &str) -> Result<(), String> {
    let p = std::ffi::CString::new(profile).map_err(|_| "profile has a NUL byte".to_string())?;
    let params: [*const c_char; 1] = [std::ptr::null()];
    let mut err: *mut c_char = std::ptr::null_mut();
    let rc = unsafe { sandbox_init_with_parameters(p.as_ptr(), 0, params.as_ptr(), &mut err) };
    if rc == 0 {
        return Ok(());
    }
    let msg = if err.is_null() {
        format!("sandbox_init_with_parameters returned {rc}")
    } else {
        let m = unsafe { std::ffi::CStr::from_ptr(err) }.to_string_lossy().into_owned();
        unsafe { sandbox_free_error(err) };
        m
    };
    Err(msg)
}

#[cfg(not(target_os = "macos"))]
pub fn apply(_profile: &str) -> Result<(), String> {
    Err("no host sandbox on this platform yet".into())
}

/// What the confined process may do with `path`, for --host-sandbox-probe:
/// a read and a write attempted after the profile is applied, each "ok" or
/// the errno's name. A write that succeeds is undone.
pub fn probe(path: &str) -> (String, String) {
    use std::fs::OpenOptions;
    let name = |e: std::io::Error| match e.raw_os_error() {
        Some(1) => "EPERM".to_string(),
        Some(13) => "EACCES".to_string(),
        Some(2) => "ENOENT".to_string(),
        _ => e.to_string(),
    };
    let read = match std::fs::File::open(path) {
        Ok(_) => "ok".to_string(),
        Err(e) => name(e),
    };
    let target = format!("{path}.berth-vmm-probe");
    let write = match OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(_) => {
            let _ = std::fs::remove_file(&target);
            "ok".to_string()
        }
        Err(e) => name(e),
    };
    (read, write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths() {
        assert_eq!(q("/a b/c"), "\"/a b/c\"");
        assert_eq!(q("/x\"y\\z"), "\"/x\\\"y\\\\z\"");
    }

    #[test]
    fn grants_only_this_sandbox() {
        let p = Plan {
            read_files: vec!["/v/kernel/Image".into(), "/v/rootfs/r.erofs".into()],
            read_dirs: vec!["/v/apps/notes".into()],
            write_files: vec!["/v/state/notes.img".into()],
            write_dirs: vec!["/r/run".into()],
            socket_dir: "/r/run".into(),
            egress: false,
        };
        let s = profile(&p);
        assert!(s.starts_with("(version 1)\n(deny default)"));
        assert!(s.contains("(allow file-read* (literal \"/v/kernel/Image\") (literal \"/v/rootfs/r.erofs\"))"));
        assert!(s.contains("(allow file-read* (subpath \"/v/apps/notes\"))"));
        assert!(s.contains("(allow file-read* file-write* (literal \"/v/state/notes.img\"))"));
        assert!(s.contains("(allow file-read* file-write* (subpath \"/r/run\"))"));
        assert!(s.contains("(local unix-socket (subpath \"/r/run\"))"));
        assert!(!s.contains("remote tcp"), "no TCP without the egress dialer");
        assert!(!s.contains("process-exec"), "berth-vmm execs nothing");
        let e = profile(&Plan { egress: true, ..p });
        assert!(e.contains("(allow network-outbound (remote tcp))"));
        assert!(e.contains("/private/var/run/mDNSResponder"), "the dialer resolves names");
    }
}
