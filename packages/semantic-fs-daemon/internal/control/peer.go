package control

import (
	"fmt"
	"net"
	"os/user"
	"strconv"
	"strings"
	"syscall"
)

// Who is on the other end of a control connection, decided by the kernel
// rather than by the caller.
//
// A `register` frame used to carry both the caller's pid and the app name it
// wished to be known by, and neither was checked: any app in the sandbox could
// register another app's pid under its own name, or its own pid under another
// app's, and poison every "created_by" attribution the FUSE layer derives from
// this registry (REMEDIATION.md 1.14). SO_PEERCRED answers both questions from
// the kernel — it stamps the connecting process's pid, uid and gid onto the
// socket at connect(2) time, and a process cannot lie about either without
// already being able to become that uid.
//
// It carried no information until every app got a uid of its own
// (docs/per-app-uid-design.md Step 2); this is Step 4 for that reason.
//
// Deliberately duplicated, not shared: context-bus-daemon implements the same
// three rules in Rust (src/peer.rs). A shared library would mean vendoring Go
// into a Rust build, and the rules are a dozen lines each. Change one, change
// the other — the tests in both name the same cases.

// The prefix entrypoint.sh gives every per-app account it creates.
const appUserPrefix = "berth-"

type peerIdentity struct {
	pid int
	uid uint32
	// name is the app this peer *is*, empty when the kernel's answer doesn't
	// resolve to one. Never taken from the request body.
	name string
	// privileged is uid 0: the host relay (docker exec), the daemons
	// themselves, anything that already has full authority in this container.
	// See docs/per-app-uid-design.md § Blocker 7.
	privileged bool
}

// resolveClaim returns the name to record for this peer given what it asked to
// be called. Only a privileged peer's claim is honoured.
func (p peerIdentity) resolveClaim(claimed string) string {
	if p.privileged {
		if claimed == "" {
			return "root"
		}
		return claimed
	}
	if p.name != "" {
		return p.name
	}
	return fmt.Sprintf("uid-%d", p.uid)
}

// contradicts reports whether the caller claimed to be someone the kernel says
// it is not — worth logging loudly, since it is either a bug or an attempt.
func (p peerIdentity) contradicts(claimed string) bool {
	return claimed != "" && p.resolveClaim(claimed) != claimed
}

// identifyPeer reads SO_PEERCRED off an accepted Unix connection.
//
// The zero value it returns on failure is deliberately the most restrictive
// answer available (not privileged, no name), not the most permissive: a
// connection whose credentials cannot be read is one whose claims are worth
// less, not more.
func identifyPeer(conn net.Conn) peerIdentity {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return peerIdentity{}
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return peerIdentity{}
	}
	var ucred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		ucred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || credErr != nil || ucred == nil {
		return peerIdentity{}
	}
	return identityFor(int(ucred.Pid), ucred.Uid, lookupUsername)
}

// identityFor is the pure half, split out so the tests can exercise the rules
// without a real socket or a real user database.
func identityFor(pid int, uid uint32, lookup func(uint32) string) peerIdentity {
	peer := peerIdentity{pid: pid, uid: uid, privileged: uid == 0}
	if peer.privileged {
		return peer
	}
	if username := lookup(uid); strings.HasPrefix(username, appUserPrefix) {
		peer.name = strings.TrimPrefix(username, appUserPrefix)
	}
	return peer
}

func lookupUsername(uid uint32) string {
	u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10))
	if err != nil {
		return ""
	}
	return u.Username
}
