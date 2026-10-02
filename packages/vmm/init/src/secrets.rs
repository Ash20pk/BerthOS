//! The secrets disk: credentials from the host, kept off the kernel command
//! line (which every process can read in /proc/cmdline).
//!
//! berth-vmm attaches the host's file read-only and names the device in
//! BERTH_SECRETS_DEV (packages/vmm/src/secrets.rs has the format). berth-init
//! reads it once, as root, before any app or daemon starts, then removes the
//! device node so nothing started later can open it. Each app gets the
//! `shared` entries plus its own `apps.<name>` entries in its environment,
//! and nothing else's: the apps run as different uids, so one cannot read
//! another's /proc/<pid>/environ. That is what the container's per-app
//! secrets files give, without a file in the guest at all.
//!
//! Nothing here ever logs or returns a value; errors name the entry at most.

use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The first bytes of a secrets disk (packages/vmm/src/secrets.rs).
pub const MAGIC: &[u8] = b"BERTHSEC1\n";
/// berth-vmm refuses a larger file; this is the guest's own bound.
pub const MAX_BYTES: u64 = 1 << 20;

pub type Entries = Vec<(String, String)>;

#[derive(Debug, Default, PartialEq)]
pub struct Secrets {
    /// To every app (names no app declared under `secrets:`).
    pub shared: Entries,
    /// App name -> to that app only.
    pub apps: BTreeMap<String, Entries>,
}

impl Secrets {
    /// What one app gets: the shared entries, then its own (which win).
    pub fn for_app(&self, name: &str) -> Entries {
        let own = self.apps.get(name);
        let mut out: Entries = self.shared.iter().filter(|(k, _)| !own.is_some_and(|o| o.iter().any(|(n, _)| n == k))).cloned().collect();
        if let Some(o) = own {
            out.extend(o.iter().cloned());
        }
        out
    }

    /// Names only, for the boot event.
    pub fn names(&self) -> Value {
        let names = |e: &Entries| e.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>();
        serde_json::json!({
            "shared": names(&self.shared),
            "apps": self.apps.iter().map(|(a, e)| (a.clone(), Value::from(names(e)))).collect::<serde_json::Map<_, _>>(),
        })
    }
}

/// An environment variable name, as the CLI and the container path accept them.
pub fn valid_name(k: &str) -> bool {
    !k.is_empty() && !k.starts_with(|c: char| c.is_ascii_digit()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn entries(v: Option<&Value>, what: &str) -> Result<Entries, String> {
    let Some(v) = v else { return Ok(vec![]) };
    let Value::Object(m) = v else { return Err(format!("{what} is not an object")) };
    let mut out = Entries::new();
    for (k, v) in m {
        if !valid_name(k) {
            return Err(format!("{what} has an entry whose name is not [A-Za-z_][A-Za-z0-9_]*"));
        }
        let Value::String(s) = v else { return Err(format!("{what}.{k} is not a string")) };
        if s.contains('\0') {
            return Err(format!("{what}.{k} contains a NUL byte"));
        }
        out.push((k.clone(), s.clone()));
    }
    Ok(out)
}

/// Parses a secrets disk's contents: the magic line, one JSON object, NUL padding.
pub fn parse(buf: &[u8]) -> Result<Secrets, String> {
    let body = buf.strip_prefix(MAGIC).ok_or("the secrets disk does not start with its header")?;
    let end = body.iter().position(|&b| b == 0).unwrap_or(body.len());
    if body[end..].iter().any(|&b| b != 0) {
        return Err("the secrets disk has data after its padding".into());
    }
    // serde_json's error says where, never what: it doesn't quote the input.
    let v: Value = serde_json::from_slice(&body[..end]).map_err(|e| format!("the secrets disk is not valid JSON ({e})"))?;
    let Value::Object(top) = &v else { return Err("the secrets disk is not a JSON object".into()) };
    if let Some(k) = top.keys().find(|k| *k != "shared" && *k != "apps") {
        return Err(format!("the secrets disk has an unknown field {k:?}"));
    }
    let shared = entries(top.get("shared"), "shared")?;
    let mut apps = BTreeMap::new();
    match top.get("apps") {
        None => {}
        Some(Value::Object(m)) => {
            for (a, e) in m {
                if !crate::plan::valid_app_name(a) {
                    return Err("the secrets disk names an app that is not a valid app name".into());
                }
                apps.insert(a.clone(), entries(Some(e), &format!("apps.{a}"))?);
            }
        }
        Some(_) => return Err("apps is not an object".into()),
    }
    Ok(Secrets { shared, apps })
}

static LOADED: OnceLock<Secrets> = OnceLock::new();

/// The secrets every app's environment draws on: empty when the sandbox has none.
pub fn loaded() -> &'static Secrets {
    LOADED.get_or_init(Secrets::default)
}

/// Reads the device, then removes its node, so that only this process ever
/// had it open. A failure is a failed boot: an app that declared a secret
/// must not start without it.
pub fn load(dev: &str) -> Result<&'static Secrets, String> {
    use std::io::Read;
    if !dev.starts_with("/dev/vd") || dev.len() != "/dev/vdX".len() {
        return Err(format!("BERTH_SECRETS_DEV={dev:?} is not a virtio block device"));
    }
    let mut buf = Vec::new();
    let read = std::fs::File::open(dev).and_then(|f| f.take(MAX_BYTES + 1).read_to_end(&mut buf));
    // Whatever happened, the node goes: nothing after this point may open it.
    let _ = crate::sys::chmod(dev, 0);
    let _ = std::fs::remove_file(dev);
    read.map_err(|e| format!("cannot read the secrets disk {dev}: {e}"))?;
    if buf.len() as u64 > MAX_BYTES {
        return Err(format!("the secrets disk {dev} is larger than {MAX_BYTES} bytes"));
    }
    let s = parse(&buf);
    buf.iter_mut().for_each(|b| *b = 0);
    let s = s?;
    LOADED.set(s).map_err(|_| "the secrets disk was loaded twice".to_string())?;
    Ok(loaded())
}

/// Adds an app's secrets to the environment berth-init built for it. A name
/// berth-init already set (PATH, BERTH_CAPABILITY_POLICY, ...) is not
/// replaced: it is returned, so the caller can say which were left out.
pub fn merge_into(env: &mut Entries, secrets: Entries) -> Vec<String> {
    let mut skipped = vec![];
    for (k, v) in secrets {
        if env.iter().any(|(n, _)| *n == k) {
            skipped.push(k);
        } else {
            env.push((k, v));
        }
    }
    skipped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(json: &str) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend_from_slice(json.as_bytes());
        b.resize(b.len().div_ceil(512) * 512, 0);
        b
    }

    fn e(pairs: &[(&str, &str)]) -> Entries {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn each_app_gets_the_shared_entries_and_its_own() {
        let s = parse(&disk(r#"{"shared":{"ANTHROPIC_API_KEY":"s1"},"apps":{"gh":{"GITHUB_TOKEN":"g1"},"notes":{"NOTES_KEY":"n1"}}}"#)).unwrap();
        assert_eq!(s.for_app("gh"), e(&[("ANTHROPIC_API_KEY", "s1"), ("GITHUB_TOKEN", "g1")]));
        assert_eq!(s.for_app("notes"), e(&[("ANTHROPIC_API_KEY", "s1"), ("NOTES_KEY", "n1")]));
        assert_eq!(s.for_app("other"), e(&[("ANTHROPIC_API_KEY", "s1")]));
    }

    #[test]
    fn an_apps_own_entry_wins_over_a_shared_one() {
        let s = parse(&disk(r#"{"shared":{"K":"shared"},"apps":{"a":{"K":"own"}}}"#)).unwrap();
        assert_eq!(s.for_app("a"), e(&[("K", "own")]));
    }

    #[test]
    fn values_may_hold_anything_the_command_line_could_not() {
        let s = parse(&disk(r#"{"apps":{"a":{"PEM":"-----BEGIN KEY-----\nab cd\"'\\\n-----END KEY-----"}}}"#)).unwrap();
        assert_eq!(s.for_app("a")[0].1, "-----BEGIN KEY-----\nab cd\"'\\\n-----END KEY-----");
    }

    #[test]
    fn errors_never_quote_a_value() {
        for bad in [
            r#"{"shared":{"1BAD":"hunter2"}}"#,
            r#"{"shared":{"K":7}}"#,
            r#"{"apps":{"../x":{"K":"hunter2"}}}"#,
            r#"{"shared":{"K":"hunter2"},"extra":1}"#,
            r#"{"shared":{"K":"hunter2"#,
        ] {
            let err = parse(&disk(bad)).unwrap_err();
            assert!(!err.contains("hunter2"), "{bad} -> {err}");
        }
    }

    #[test]
    fn refuses_a_bad_envelope() {
        assert!(parse(b"{}").unwrap_err().contains("header"));
        let mut d = disk("{}");
        let n = d.len();
        d[n - 1] = b'x';
        assert!(parse(&d).unwrap_err().contains("after its padding"));
        assert_eq!(parse(&disk("{}")).unwrap(), Secrets::default());
    }

    #[test]
    fn a_name_berth_init_set_is_not_replaced() {
        let mut env = e(&[("PATH", "/usr/bin"), ("BERTH_CAPABILITY_POLICY", "/run/berth/policy/a.json")]);
        let skipped = merge_into(&mut env, e(&[("PATH", "/evil"), ("GITHUB_TOKEN", "g")]));
        assert_eq!(skipped, vec!["PATH".to_string()]);
        assert_eq!(env, e(&[("PATH", "/usr/bin"), ("BERTH_CAPABILITY_POLICY", "/run/berth/policy/a.json"), ("GITHUB_TOKEN", "g")]));
    }

    #[test]
    fn the_boot_event_has_names_only() {
        let s = parse(&disk(r#"{"shared":{"A":"x1"},"apps":{"gh":{"T":"x2"}}}"#)).unwrap();
        let n = s.names().to_string();
        assert_eq!(n, r#"{"apps":{"gh":["T"]},"shared":["A"]}"#);
    }
}
