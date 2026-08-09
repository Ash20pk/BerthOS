// Who is on the other end of a Unix socket, decided by the kernel rather than
// by the caller.
//
// Every request frame this daemon accepts used to carry the caller's own claim
// about which app it is (`Register { app }`), and nothing checked it: any app
// in the sandbox could register, publish, and be logged as any other
// (REMEDIATION.md 1.14). SO_PEERCRED is the fix — the kernel stamps the
// connecting process's uid onto the socket at connect(2) time, and a process
// cannot lie about it without already being able to become that uid.
//
// This carried no information until every app got a uid of its own
// (docs/per-app-uid-design.md Step 2); it is Step 4 for that reason.
//
// Deliberately duplicated, not shared: semantic-fs-daemon implements the same
// three rules in Go (internal/control/peer.go). A shared crate would mean
// vendoring Rust into a Go build, and the rules are eight lines each. Change
// one, change the other — the tests in both name the same three cases.

/// What the kernel says about the process on the other end of a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerIdentity {
    /// uid 0. The host relay (`docker exec`), the daemons themselves, and
    /// anything else that already has full authority inside this container —
    /// see docs/per-app-uid-design.md § Blocker 7. A root caller's own claim
    /// about which app it is stands, because it could set that uid anyway.
    Privileged,
    /// A resident app, named by resolving its uid through the user database
    /// entrypoint.sh populated (`berth-<app>`).
    App(String),
    /// A uid that resolves to no known app. Not an error — a container may
    /// legitimately run something else — but its claim about an app name is
    /// worth exactly nothing, so it gets an identity derived from the uid.
    Unknown(u32),
}

impl PeerIdentity {
    /// The name to record for this peer, given what it asked to be called.
    /// Only a privileged peer's claim is honoured.
    pub fn resolve_claim(&self, claimed: &str) -> String {
        match self {
            // A root caller that named nothing is still worth naming: an empty
            // string in a log line reads as a bug rather than as "the relay".
            PeerIdentity::Privileged if claimed.is_empty() => "root".to_string(),
            PeerIdentity::Privileged => claimed.to_string(),
            PeerIdentity::App(name) => name.clone(),
            PeerIdentity::Unknown(uid) => format!("uid-{uid}"),
        }
    }

    /// True when the caller claimed to be someone the kernel says it is not —
    /// the case worth logging loudly, since it is either a bug or an attempt.
    pub fn contradicts(&self, claimed: &str) -> bool {
        !claimed.is_empty() && self.resolve_claim(claimed) != claimed
    }
}

/// The prefix entrypoint.sh gives every per-app account it creates.
const APP_USER_PREFIX: &str = "berth-";

pub fn identify(uid: u32, passwd: &str) -> PeerIdentity {
    if uid == 0 {
        return PeerIdentity::Privileged;
    }
    match app_name_for_uid(uid, passwd) {
        Some(name) => PeerIdentity::App(name),
        None => PeerIdentity::Unknown(uid),
    }
}

/// Reads the real user database. `/etc/passwd` is parsed directly rather than
/// through getpwuid(3), which would mean either an unsafe libc call or a new
/// dependency for a five-line file format — and this image has no NSS modules
/// beyond files, so the two would return the same answer.
pub fn identify_from_system(uid: u32) -> PeerIdentity {
    let passwd = std::fs::read_to_string("/etc/passwd").unwrap_or_default();
    identify(uid, &passwd)
}

fn app_name_for_uid(uid: u32, passwd: &str) -> Option<String> {
    for line in passwd.lines() {
        let mut fields = line.split(':');
        let name = fields.next()?;
        let _password = fields.next();
        let entry_uid = fields.next().and_then(|raw| raw.parse::<u32>().ok());
        if entry_uid == Some(uid) {
            return name.strip_prefix(APP_USER_PREFIX).map(str::to_string);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/sh\n\
                          nobody:x:65534:65534:nobody:/:/sbin/nologin\n\
                          berth-notes:x:10000:10000:notes:/:/sbin/nologin\n\
                          berth-code-interpreter:x:10001:10001::/:/sbin/nologin\n";

    #[test]
    fn a_root_peer_keeps_its_own_claim() {
        let peer = identify(0, PASSWD);
        assert_eq!(peer, PeerIdentity::Privileged);
        assert_eq!(peer.resolve_claim("anything-at-all"), "anything-at-all");
        assert!(!peer.contradicts("anything-at-all"));
        assert_eq!(peer.resolve_claim(""), "root");
        assert!(!peer.contradicts(""));
    }

    // The whole point: a claim that disagrees with the kernel loses.
    #[test]
    fn an_apps_claim_to_be_another_app_is_overridden() {
        let peer = identify(10001, PASSWD);
        assert_eq!(peer, PeerIdentity::App("code-interpreter".to_string()));
        assert_eq!(peer.resolve_claim("notes"), "code-interpreter");
        assert!(peer.contradicts("notes"));
        // ...and an honest claim is not flagged as a contradiction.
        assert!(!peer.contradicts("code-interpreter"));
    }

    #[test]
    fn an_unrecognised_uid_gets_an_identity_derived_from_the_uid() {
        let peer = identify(65534, PASSWD);
        assert_eq!(peer, PeerIdentity::Unknown(65534));
        assert_eq!(peer.resolve_claim("filesystem"), "uid-65534");
        assert!(peer.contradicts("filesystem"));
    }

    // A non-app account whose name happens to lack the prefix must not be
    // silently accepted as an app — otherwise adding any system user to the
    // image would hand it an app identity.
    #[test]
    fn a_uid_that_is_not_a_berth_app_account_is_not_an_app() {
        assert_eq!(identify(65534, PASSWD), PeerIdentity::Unknown(65534));
    }

    #[test]
    fn a_malformed_passwd_line_is_skipped_rather_than_ending_the_scan() {
        let passwd = "garbage\n\nberth-notes:x:10000:10000::/:/sbin/nologin\n";
        assert_eq!(identify(10000, passwd), PeerIdentity::App("notes".to_string()));
    }

    // An empty claim (a client that never sent a name) is not a contradiction
    // — there is nothing to contradict — but it still resolves to the kernel's
    // answer rather than staying empty.
    #[test]
    fn an_absent_claim_still_resolves_to_the_kernels_answer() {
        let peer = identify(10000, PASSWD);
        assert!(!peer.contradicts(""));
        assert_eq!(peer.resolve_claim(""), "notes");
    }
}
