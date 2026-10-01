// The egress dialer: the host half of a sandbox's network access.
//
// The guest has no NIC and TSI is off. Its egress broker (egress-broker.cjs,
// gate 1) checks an app's request against the declared host patterns, then
// asks for the upstream connection over vsock port 1026, which libkrun maps
// (guest connects out) to a Unix socket this dialer listens on. This is gate
// 2, and it trusts nothing from the guest: guest root can open vsock, so any
// request may come from a compromised guest. For every connection it
//
//   - reads one bounded request line, `DIAL <host> <port>\n`,
//   - checks host:port against the allowlist the host was given at launch
//     (--egress-allow, computed by the CLI from the sandbox's manifests;
//     never read from the guest), with the broker's matching rules,
//   - resolves the name itself and refuses if any answer is an internal
//     address (loopback, private, link-local and metadata, CGNAT, ULA, ...),
//   - connects to the address it checked (pinned: no second lookup),
//   - answers `OK <address>\n` and then copies bytes both ways (TLS stays end
//     to end; nothing here terminates it), or `ERR <code> <message>\n`,
//   - and logs one JSON line per request on stderr.
//
// Concurrent tunnels are capped. See docs/design/microvm-egress.md.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// The vsock port the guest dials out on (docs/design/microvm-egress.md).
pub const EGRESS_PORT: u32 = 1026;
/// What a pattern that names no port covers (egress-broker.cjs's DEFAULT_ALLOWED_PORTS).
pub const DEFAULT_PORTS: [u16; 2] = [80, 443];
/// Longest request line, newline included.
pub const MAX_REQUEST_LINE: usize = 1024;
pub const DEFAULT_MAX_CONNS: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Most patterns one --egress-allow may carry.
const MAX_PATTERNS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PortRule {
    /// No port in the pattern: 80 and 443.
    Default,
    /// `host:*`.
    Any,
    One(u16),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    /// Lowercased; `*` is the only wildcard and matches any run of characters.
    pub host: String,
    pub port: PortRule,
}

impl Pattern {
    pub fn display(&self) -> String {
        match self.port {
            PortRule::Default => self.host.clone(),
            PortRule::Any => format!("{}:*", self.host),
            PortRule::One(p) => format!("{}:{p}", self.host),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub socket: PathBuf,
    pub allow: Vec<Pattern>,
    pub max_conns: usize,
}

/// One capability scope, as `network:host:<scope>` carries it: a host glob
/// and an optional port after the LAST colon, only when it looks like a port
/// (egress-broker.cjs's parseScope).
pub fn parse_pattern(s: &str) -> Result<Pattern, String> {
    let s = s.trim();
    let (host, port) = match s.rfind(':') {
        Some(i) if i > 0 => {
            let suffix = &s[i + 1..];
            if suffix == "*" {
                (&s[..i], PortRule::Any)
            } else if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                match suffix.parse::<u16>() {
                    Ok(p) if p > 0 => (&s[..i], PortRule::One(p)),
                    _ => return Err(format!("egress pattern {s:?}: port must be 1-65535")),
                }
            } else {
                return Err(format!("egress pattern {s:?}: the part after ':' must be a port or *"));
            }
        }
        _ => (s, PortRule::Default),
    };
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 || !host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'*') {
        return Err(format!("egress pattern {s:?}: host must be [a-z0-9.-] with * as the only wildcard"));
    }
    Ok(Pattern { host, port })
}

/// `--egress-allow` values: comma separated patterns; may be given several times.
pub fn parse_allowlist(specs: &[String]) -> Result<Vec<Pattern>, String> {
    let mut out = Vec::new();
    for spec in specs {
        for p in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let pat = parse_pattern(p)?;
            if !out.contains(&pat) {
                out.push(pat);
            }
        }
    }
    if out.len() > MAX_PATTERNS {
        return Err(format!("at most {MAX_PATTERNS} egress patterns"));
    }
    Ok(out)
}

/// `*` matches any run of characters (dots included), as the broker's
/// globToRegExp does; everything else is literal.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.as_bytes(), name.as_bytes());
    let (mut pi, mut ni) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ni < n.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if pi < p.len() && p[pi] == n[ni] {
            pi += 1;
            ni += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn allows(allow: &[Pattern], host: &str, port: u16) -> bool {
    allow.iter().any(|p| {
        glob_match(&p.host, host)
            && match p.port {
                PortRule::Default => DEFAULT_PORTS.contains(&port),
                PortRule::Any => true,
                PortRule::One(q) => q == port,
            }
    })
}

/// A request's host: a DNS name or an IP literal, lowercased. A name whose
/// last label is numeric must be a canonical dotted-quad: `127.1` or
/// `2130706433` would otherwise reach inet_aton's shorthand forms. (The
/// address check after resolution refuses those anyway; this refuses them
/// before a lookup.)
pub fn normalize_host(h: &str) -> Option<String> {
    if h.parse::<Ipv6Addr>().is_ok() {
        return Some(h.to_ascii_lowercase());
    }
    let h = h.to_ascii_lowercase();
    if h.is_empty() || h.len() > 253 || !h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-') {
        return None;
    }
    let labels: Vec<&str> = h.split('.').collect();
    if labels.iter().any(|l| l.is_empty() || l.len() > 63 || l.starts_with('-') || l.ends_with('-')) {
        return None;
    }
    let last = labels[labels.len() - 1];
    if last.bytes().all(|b| b.is_ascii_digit()) && h.parse::<Ipv4Addr>().is_err() {
        return None;
    }
    Some(h)
}

/// Why an IPv4 address is never dialled, or None when it may be.
pub fn blocked_v4(ip: Ipv4Addr) -> Option<&'static str> {
    let [a, b, c, _] = ip.octets();
    Some(match (a, b, c) {
        (0, _, _) => "this-network (0/8)",
        (10, _, _) => "private (10/8)",
        (127, _, _) => "loopback (127/8)",
        (169, 254, _) => "link-local and cloud metadata (169.254/16)",
        (172, 16..=31, _) => "private (172.16/12)",
        (192, 168, _) => "private (192.168/16)",
        (100, 64..=127, _) => "carrier-grade NAT (100.64/10)",
        (192, 0, 0) => "IETF protocol assignments (192.0.0/24)",
        (192, 0, 2) | (198, 51, 100) | (203, 0, 113) => "documentation",
        (198, 18..=19, _) => "benchmarking (198.18/15)",
        (224..=255, _, _) => "multicast, reserved or broadcast (224/3)",
        _ => return None,
    })
}

/// Why an IPv6 address is never dialled, or None when it may be.
pub fn blocked_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let s = ip.segments();
    if ip.is_unspecified() {
        return Some("unspecified (::)");
    }
    if ip.is_loopback() {
        return Some("loopback (::1)");
    }
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible, deprecated) and the
    // NAT64 prefix 64:ff9b::/96 all carry an IPv4 address that a stack may
    // reach; judge them by it.
    let embedded = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    if s[..5] == [0, 0, 0, 0, 0] && (s[5] == 0xffff || s[5] == 0) {
        return Some(blocked_v4(embedded).map_or("IPv4-mapped or -compatible", |_| "IPv4-mapped or -compatible internal address"));
    }
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return blocked_v4(embedded).map(|_| "NAT64 of an internal IPv4 address");
    }
    Some(match s[0] {
        x if x & 0xfe00 == 0xfc00 => "unique local (fc00::/7, incl. fd00::/8 metadata)",
        x if x & 0xffc0 == 0xfe80 => "link-local (fe80::/10)",
        x if x & 0xffc0 == 0xfec0 => "site-local (fec0::/10)",
        x if x & 0xff00 == 0xff00 => "multicast (ff00::/8)",
        0x2001 if s[1] == 0x0db8 => "documentation (2001:db8::/32)",
        0x0100 if s[1..4] == [0, 0, 0] => "discard (100::/64)",
        _ => return None,
    })
}

pub fn blocked(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v) => blocked_v4(v),
        IpAddr::V6(v) => blocked_v6(v),
    }
}

/// `DIAL <host> <port>` with single spaces and nothing else.
pub fn parse_request(line: &str) -> Result<(String, u16), &'static str> {
    let mut parts = line.split(' ');
    let (Some("DIAL"), Some(host), Some(port), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("expected DIAL <host> <port>");
    };
    if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) || port.starts_with('0') {
        return Err("port must be 1-65535");
    }
    let port: u16 = port.parse().map_err(|_| "port must be 1-65535")?;
    let host = normalize_host(host).ok_or("host is not a DNS name or IP literal")?;
    Ok((host, port))
}

/// The addresses to dial, IPv4 first, or why not. Refuses when ANY answer
/// is internal: a name that resolves to a private address next to a public
/// one is misconfigured or a rebinding attempt, and is not dialled either way.
pub fn vet_addresses(mut addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    if addrs.is_empty() {
        return Err("no address".into());
    }
    if let Some((a, why)) = addrs.iter().find_map(|a| blocked(a.ip()).map(|w| (a, w))) {
        return Err(format!("resolves to {} ({why})", a.ip()));
    }
    addrs.sort_by_key(|a| a.is_ipv6());
    addrs.dedup();
    Ok(addrs)
}

/// The host's resolver, bounded: getaddrinfo cannot be cancelled, so it runs
/// on its own thread and a slow lookup is abandoned.
fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let (tx, rx) = mpsc::channel();
    let h = host.to_string();
    std::thread::spawn(move || {
        let _ = tx.send((h.as_str(), port).to_socket_addrs().map(|i| i.collect::<Vec<_>>()));
    });
    match rx.recv_timeout(RESOLVE_TIMEOUT) {
        Ok(Ok(a)) => Ok(a),
        Ok(Err(e)) => Err(format!("lookup failed: {e}")),
        Err(_) => Err(format!("lookup timed out after {} s", RESOLVE_TIMEOUT.as_secs())),
    }
}

/// Strings in a log line are hosts and fixed reasons, already restricted to
/// [a-z0-9.:-] or ASCII prose; quote them as JSON anyway.
fn js(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn log(line: String) {
    eprintln!("{{\"source\":\"berth-vmm\",{line}}}");
}

struct Dialer {
    allow: Vec<Pattern>,
    max_conns: usize,
    active: AtomicUsize,
    next_id: AtomicU64,
}

/// Starts the dialer on its own threads. It lives as long as the process
/// (libkrun exits the process when the guest powers off).
pub fn start(cfg: &Config) -> Result<(), String> {
    let _ = std::fs::remove_file(&cfg.socket);
    let listener = UnixListener::bind(&cfg.socket).map_err(|e| format!("egress dialer: cannot listen on {}: {e}", cfg.socket.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&cfg.socket, std::fs::Permissions::from_mode(0o600));
    }
    let d = Arc::new(Dialer { allow: cfg.allow.clone(), max_conns: cfg.max_conns, active: AtomicUsize::new(0), next_id: AtomicU64::new(1) });
    let allow: Vec<String> = cfg.allow.iter().map(|p| js(&p.display())).collect();
    log(format!(
        "\"event\":\"egress_dialer\",\"socket\":{},\"vsockPort\":{EGRESS_PORT},\"allow\":[{}],\"maxConns\":{}",
        js(&cfg.socket.display().to_string()),
        allow.join(","),
        cfg.max_conns
    ));
    std::thread::Builder::new()
        .name("egress".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let id = d.next_id.fetch_add(1, Ordering::SeqCst);
                if d.active.fetch_add(1, Ordering::SeqCst) >= d.max_conns {
                    d.active.fetch_sub(1, Ordering::SeqCst);
                    deny(id, &conn, "busy", "", 0, &format!("{} tunnels open, the cap", d.max_conns));
                    continue;
                }
                let d = d.clone();
                std::thread::spawn(move || {
                    handle(&d, id, conn);
                    d.active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        })
        .map_err(|e| format!("egress dialer thread: {e}"))?;
    Ok(())
}

fn deny(id: u64, mut conn: &UnixStream, code: &str, host: &str, port: u16, why: &str) {
    let decision = if code == "unreachable" { "failed" } else { "denied" };
    log(format!("\"event\":\"egress\",\"id\":{id},\"decision\":\"{decision}\",\"code\":\"{code}\",\"host\":{},\"port\":{port},\"reason\":{}", js(host), js(why)));
    let _ = conn.write_all(format!("ERR {code} {why}\n").as_bytes());
    let _ = conn.shutdown(Shutdown::Both);
}

fn read_request(conn: &UnixStream) -> Result<String, &'static str> {
    conn.set_read_timeout(Some(REQUEST_TIMEOUT)).map_err(|_| "socket error")?;
    let mut rd = BufReader::new(conn.try_clone().map_err(|_| "socket error")?).take(MAX_REQUEST_LINE as u64);
    let mut buf = Vec::new();
    match rd.read_until(b'\n', &mut buf) {
        Ok(_) if buf.last() == Some(&b'\n') => {}
        Ok(n) if n >= MAX_REQUEST_LINE => return Err("request line too long"),
        Ok(_) => return Err("no complete request line"),
        Err(_) => return Err("no request line in time"),
    }
    // Nothing may follow the request before the answer; a guest that sends
    // payload early has it in the BufReader and loses it, which is its problem.
    buf.pop();
    String::from_utf8(buf).map_err(|_| "request is not UTF-8")
}

fn handle(d: &Dialer, id: u64, conn: UnixStream) {
    let line = match read_request(&conn) {
        Ok(l) => l,
        Err(why) => return deny(id, &conn, "bad_request", "", 0, why),
    };
    let (host, port) = match parse_request(&line) {
        Ok(r) => r,
        Err(why) => return deny(id, &conn, "bad_request", "", 0, why),
    };
    if !allows(&d.allow, &host, port) {
        return deny(id, &conn, "denied", &host, port, "not in this sandbox's egress allowlist");
    }
    let addrs = match resolve(&host, port) {
        Ok(a) => a,
        Err(why) => return deny(id, &conn, "unresolved", &host, port, &why),
    };
    let addrs = match vet_addresses(addrs) {
        Ok(a) => a,
        Err(why) => return deny(id, &conn, "denied", &host, port, &why),
    };
    let mut upstream = None;
    let mut last_err = String::new();
    for a in &addrs {
        match TcpStream::connect_timeout(a, CONNECT_TIMEOUT) {
            Ok(s) => {
                upstream = Some((s, *a));
                break;
            }
            Err(e) => last_err = format!("{a}: {e}"),
        }
    }
    let Some((up, addr)) = upstream else {
        return deny(id, &conn, "unreachable", &host, port, &last_err);
    };
    log(format!(
        "\"event\":\"egress\",\"id\":{id},\"decision\":\"allowed\",\"host\":{},\"port\":{port},\"address\":{}",
        js(&host),
        js(&addr.ip().to_string())
    ));
    let mut c = &conn;
    if c.write_all(format!("OK {}\n", addr.ip()).as_bytes()).is_err() {
        return;
    }
    let _ = conn.set_read_timeout(None);
    let t = Instant::now();
    let (sent, received) = splice(conn, up);
    log(format!(
        "\"event\":\"egress_closed\",\"id\":{id},\"host\":{},\"port\":{port},\"bytesUp\":{sent},\"bytesDown\":{received},\"ms\":{}",
        js(&host),
        t.elapsed().as_millis()
    ));
}

/// Copies both ways until both directions end; returns (guest→remote, remote→guest) bytes.
fn splice(guest: UnixStream, remote: TcpStream) -> (u64, u64) {
    let (Ok(mut g_r), Ok(mut r_w)) = (guest.try_clone(), remote.try_clone()) else { return (0, 0) };
    let up = std::thread::spawn(move || {
        let n = std::io::copy(&mut g_r, &mut r_w).unwrap_or(0);
        let _ = r_w.shutdown(Shutdown::Write);
        n
    });
    let (mut r_r, mut g_w) = (remote, guest);
    let down = std::io::copy(&mut r_r, &mut g_w).unwrap_or(0);
    let _ = g_w.shutdown(Shutdown::Write);
    (up.join().unwrap_or(0), down)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(s: &str) -> Vec<Pattern> {
        parse_allowlist(&[s.to_string()]).unwrap()
    }

    #[test]
    fn patterns_parse_like_the_broker_scope() {
        assert_eq!(parse_pattern("example.com").unwrap(), Pattern { host: "example.com".into(), port: PortRule::Default });
        assert_eq!(parse_pattern("Example.COM:8443").unwrap(), Pattern { host: "example.com".into(), port: PortRule::One(8443) });
        assert_eq!(parse_pattern("*.example.org:*").unwrap(), Pattern { host: "*.example.org".into(), port: PortRule::Any });
        assert_eq!(parse_pattern("*").unwrap().port, PortRule::Default);
        for bad in ["", ":443", "a b", "a:0", "a:70000", "a:x", "a/b", "a?b", "[::1]:443", "a:443:"] {
            assert!(parse_pattern(bad).is_err(), "{bad:?}");
        }
        assert_eq!(allow("a.com, b.com:81,,a.com").len(), 2);
    }

    #[test]
    fn glob_is_star_only() {
        assert!(glob_match("*.example.com", "api.example.com"));
        assert!(glob_match("*.example.com", "a.b.example.com"));
        assert!(!glob_match("*.example.com", "example.com"));
        assert!(!glob_match("*.example.com", "example.com.evil.net"));
        assert!(glob_match("*", "anything.at.all"));
        assert!(glob_match("api*.example.com", "api-2.example.com"));
        assert!(!glob_match("example.com", "example.co"));
        assert!(!glob_match("example.com", "xexample.com"));
        // '?' and '.' are literal, unlike in a regex.
        assert!(!glob_match("a?.example.com", ".example.com"));
        assert!(!glob_match("a.c", "abc"));
    }

    #[test]
    fn ports_default_to_80_and_443() {
        let a = allow("example.com,db.internal.example:5432,*.cdn.example:*");
        assert!(allows(&a, "example.com", 443));
        assert!(allows(&a, "example.com", 80));
        assert!(!allows(&a, "example.com", 22));
        assert!(allows(&a, "db.internal.example", 5432));
        assert!(!allows(&a, "db.internal.example", 443));
        assert!(allows(&a, "x.cdn.example", 6667));
        assert!(!allows(&a, "evil.com", 443));
        assert!(!allows(&[], "example.com", 443));
    }

    #[test]
    fn requests_are_strict() {
        assert_eq!(parse_request("DIAL example.com 443"), Ok(("example.com".into(), 443)));
        assert_eq!(parse_request("DIAL Example.Com 80"), Ok(("example.com".into(), 80)));
        assert_eq!(parse_request("DIAL 1.2.3.4 443"), Ok(("1.2.3.4".into(), 443)));
        assert_eq!(parse_request("DIAL ::1 443"), Ok(("::1".into(), 443)));
        for bad in [
            "", "DIAL", "DIAL example.com", "DIAL example.com 443 x", "dial example.com 443", "DIAL  example.com 443",
            "DIAL example.com 0", "DIAL example.com 65536", "DIAL example.com 0443", "DIAL example.com -1",
            "DIAL exa_mple.com 443", "DIAL example..com 443", "DIAL .example.com 443", "DIAL -x.com 443",
            "DIAL 127.1 443", "DIAL 2130706433 443", "DIAL 1.2.3.4.5 443", "DIAL a/b 443", "DIAL example.com\r 443",
            "DIAL example.com 443\r",
        ] {
            assert!(parse_request(bad).is_err(), "{bad:?}");
        }
        assert!(parse_request(&format!("DIAL {}.com 443", "a".repeat(64))).is_err());
    }

    #[test]
    fn internal_ipv4_is_blocked() {
        for ip in [
            "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
            "192.168.1.1", "100.64.0.1", "100.100.100.200", "192.0.0.170", "192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1",
            "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(blocked(ip.parse().unwrap()).is_some(), "{ip}");
        }
        for ip in ["93.184.215.14", "1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "192.169.0.1", "223.255.255.255"] {
            assert!(blocked(ip.parse().unwrap()).is_none(), "{ip}");
        }
    }

    #[test]
    fn internal_ipv6_is_blocked() {
        for ip in [
            "::", "::1", "fd00:ec2::254", "fd12:3456::1", "fc00::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "100::1",
            "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1",
            "::ffff:93.184.215.14",
        ] {
            assert!(blocked(ip.parse().unwrap()).is_some(), "{ip}");
        }
        for ip in ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "2001:4860:4860::8888", "64:ff9b::5db8:d70e"] {
            assert!(blocked(ip.parse().unwrap()).is_none(), "{ip}");
        }
    }

    #[test]
    fn any_internal_answer_refuses_the_dial() {
        let sa = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert!(vet_addresses(vec![]).is_err());
        assert!(vet_addresses(vec![sa("93.184.215.14:443"), sa("10.0.0.1:443")]).is_err());
        assert!(vet_addresses(vec![sa("[::1]:443"), sa("93.184.215.14:443")]).is_err());
        let ok = vet_addresses(vec![sa("[2606:2800:21f:cb07:6820:80da:af6b:8b2c]:443"), sa("93.184.215.14:443"), sa("93.184.215.14:443")]).unwrap();
        assert_eq!(ok, vec![sa("93.184.215.14:443"), sa("[2606:2800:21f:cb07:6820:80da:af6b:8b2c]:443")]);
    }

    #[test]
    fn localhost_resolves_and_is_refused() {
        // The host's own resolver: whatever localhost answers, it is internal.
        let a = resolve("localhost", 80).unwrap();
        assert!(vet_addresses(a).is_err());
        assert!(vet_addresses(resolve("127.0.0.1", 80).unwrap()).is_err());
    }

    /// The whole dialer over its Unix socket, against a local TCP listener
    /// the allowlist names by an internal address: the address check must
    /// refuse it even though the allowlist "allows" it.
    #[test]
    fn dialer_end_to_end_refusals() {
        let dir = std::env::temp_dir().join(format!("berth-egress-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("e.sock");
        start(&Config { socket: sock.clone(), allow: allow("127.0.0.1:*,localhost:*,allowed.invalid"), max_conns: 4 }).unwrap();
        let ask = |req: &[u8]| {
            let mut c = UnixStream::connect(&sock).unwrap();
            c.write_all(req).unwrap();
            let mut s = String::new();
            let _ = c.read_to_string(&mut s);
            s
        };
        assert!(ask(b"DIAL 127.0.0.1 8080\n").starts_with("ERR denied resolves to 127.0.0.1"));
        assert!(ask(b"DIAL localhost 8080\n").starts_with("ERR denied resolves to"));
        assert!(ask(b"DIAL example.com 443\n").starts_with("ERR denied not in this sandbox"));
        assert!(ask(b"DIAL 169.254.169.254 80\n").starts_with("ERR denied not in"));
        assert!(ask(b"DIAL allowed.invalid 443\n").starts_with("ERR unresolved"));
        assert!(ask(b"GET / HTTP/1.1\n").starts_with("ERR bad_request"));
        assert!(ask(&[b'x'; 2000]).starts_with("ERR bad_request request line too long"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn connections_are_capped() {
        let dir = std::env::temp_dir().join(format!("berth-egress-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("e.sock");
        start(&Config { socket: sock.clone(), allow: allow("example.com"), max_conns: 1 }).unwrap();
        // Holds the only slot: connected, request not sent yet.
        let _held = UnixStream::connect(&sock).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let mut c = UnixStream::connect(&sock).unwrap();
        let mut s = String::new();
        let _ = c.read_to_string(&mut s);
        assert!(s.starts_with("ERR busy"), "{s:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
