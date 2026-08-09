package control

import "testing"

// The same three cases context-bus-daemon's src/peer.rs asserts in Rust. They
// are duplicated implementations by design (see peer.go's header), so they are
// duplicated tests too — a divergence between the two daemons' rules is the
// thing most likely to go unnoticed.

func fakeLookup(names map[uint32]string) func(uint32) string {
	return func(uid uint32) string { return names[uid] }
}

var accounts = fakeLookup(map[uint32]string{
	10000: "berth-notes",
	10001: "berth-code-interpreter",
	65534: "nobody",
})

func TestRootPeerKeepsItsOwnClaim(t *testing.T) {
	peer := identityFor(42, 0, accounts)
	if !peer.privileged {
		t.Fatalf("uid 0 must be privileged")
	}
	if got := peer.resolveClaim("anything-at-all"); got != "anything-at-all" {
		t.Fatalf("a root caller's claim must stand, got %q", got)
	}
	if got := peer.resolveClaim(""); got != "root" {
		t.Fatalf("a root caller that named nothing should be recorded as root, got %q", got)
	}
	if peer.contradicts("anything-at-all") {
		t.Fatal("a root caller never contradicts")
	}
}

// The whole point: a claim that disagrees with the kernel loses.
func TestAnAppsClaimToBeAnotherAppIsOverridden(t *testing.T) {
	peer := identityFor(77, 10001, accounts)
	if peer.name != "code-interpreter" {
		t.Fatalf("expected the uid to resolve to code-interpreter, got %q", peer.name)
	}
	if got := peer.resolveClaim("notes"); got != "code-interpreter" {
		t.Fatalf("expected the kernel's answer to win, got %q", got)
	}
	if !peer.contradicts("notes") {
		t.Fatal("claiming another app's name must be reported as a contradiction")
	}
	if peer.contradicts("code-interpreter") {
		t.Fatal("an honest claim must not be reported as a contradiction")
	}
}

func TestAnUnrecognisedUidGetsAnIdentityDerivedFromTheUid(t *testing.T) {
	// nobody exists in the user database but is not a berth-<app> account, so
	// it must not be handed an app identity — otherwise adding any system user
	// to the image would grant one.
	peer := identityFor(9, 65534, accounts)
	if peer.name != "" {
		t.Fatalf("a non-app account must not resolve to an app, got %q", peer.name)
	}
	if got := peer.resolveClaim("filesystem"); got != "uid-65534" {
		t.Fatalf("expected a uid-derived identity, got %q", got)
	}
	if !peer.contradicts("filesystem") {
		t.Fatal("an unrecognised uid claiming an app name is a contradiction")
	}
}

// identifyPeer's failure path returns the zero value, and the zero value must
// be the most restrictive answer rather than the most permissive — a peer whose
// credentials could not be read must never come back as root.
func TestTheZeroIdentityIsNotPrivileged(t *testing.T) {
	var peer peerIdentity
	if peer.privileged {
		t.Fatal("the zero identity must not be privileged")
	}
	if got := peer.resolveClaim("filesystem"); got != "uid-0" {
		t.Fatalf("expected the zero identity to resolve away from any claim, got %q", got)
	}
}
