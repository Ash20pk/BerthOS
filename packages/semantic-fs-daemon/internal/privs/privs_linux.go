// Package privs narrows this daemon's privileges once the FUSE mount is up
// (BUILD_PLAN M1.2; threat model B4).
//
// mount(2) is the only reason this process holds CAP_SYS_ADMIN, and it is
// needed exactly once, at boot. Everything the daemon does afterwards —
// serving FUSE requests against the backing tree, chgrp'ing backing files to
// the shared berth group (ownership.go), answering the control socket — needs
// at most the small file-ownership set kept below. So after fuse.Mount
// returns, the *entire* capability bounding set is dropped and the
// permitted/effective sets are reduced to that file-ownership set, on every
// thread (Go's runtime spawns threads before main runs, and Linux capability
// sets are per-thread — syscall.AllThreadsSyscall is the only way to change
// them all coherently; it works here because this module is pure Go, no cgo).
//
// What this buys: a compromise of the FUSE/control-socket request paths no
// longer holds mount(2). It cannot re-mount over its own restrictions,
// cannot mount tmpfs over the backing store, and — because the bounding set
// is empty and no_new_privs is set — cannot get any of it back via exec of a
// setuid/file-caps binary. The uid stays 0: the backing tree's root:berth
// ownership model is built around it,
// and CAP_CHOWN/CAP_FOWNER without uid 0 would still need most of the same
// trust. Named residual, not an accident.
//
// One consequence stated plainly: this process can no longer unmount its own
// mountpoint. It never did so on a clean path (the sidecar dies with its
// container and the next boot's entrypoint sweeps stale mounts lazily —
// see semantic-fs-sidecar.ts's mountId), so nothing is lost, but a future
// "unmount on SIGTERM" feature would have to happen before this narrowing.
package privs

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The kept set. CAP_CHOWN: ownership.go chgrps backing files to the shared
// berth gid, and root is not necessarily a member of it. CAP_FOWNER: chmod
// on backing files whose mode bits the ownership pass normalizes. CAP_FSETID:
// lets the setgid bit survive those operations on group-shared directories.
// CAP_DAC_OVERRIDE: the backing tree deliberately carries modes that exclude
// "other", and the daemon must serve every app's files regardless.
var keptCaps = []int{
	unix.CAP_CHOWN,
	unix.CAP_DAC_OVERRIDE,
	unix.CAP_FOWNER,
	unix.CAP_FSETID,
}

func capLastCap() int {
	raw, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		// CAP_CHECKPOINT_RESTORE (40) is the highest cap on any kernel this
		// runs on; dropping a few nonexistent ones is a harmless EINVAL that
		// the loop below tolerates, while *underestimating* would silently
		// leave real caps in the bounding set.
		return 63
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 63
	}
	return n
}

// NarrowPostMount performs the drop described in the package comment.
// Returns an error (and changes as little as possible) when any step is
// refused — the caller logs it and continues, matching this repo's
// warn-don't-fail convention for daemons, and the milestone test is what
// asserts the drop actually happens on a real boot.
func NarrowPostMount() error {
	last := capLastCap()

	// Bounding set first, while CAP_SETPCAP (which PR_CAPBSET_DROP requires)
	// is still in the effective set — and CAP_SETPCAP itself last, so the
	// loop doesn't saw off the branch it stands on. EINVAL means "this
	// kernel doesn't know that capability number" and is tolerated; EPERM
	// means the drop is not happening and is not.
	for cap := 0; cap <= last; cap++ {
		if cap == unix.CAP_SETPCAP {
			continue
		}
		if err := capBoundingDropAllThreads(cap); err != nil {
			return fmt.Errorf("PR_CAPBSET_DROP(%d): %w", cap, err)
		}
	}
	if err := capBoundingDropAllThreads(unix.CAP_SETPCAP); err != nil {
		return fmt.Errorf("PR_CAPBSET_DROP(CAP_SETPCAP): %w", err)
	}

	// Now the thread-credential sets: permitted/effective reduced to the
	// kept set, inheritable cleared. Reducing is always allowed; this can
	// only fail on a malformed call.
	var want [2]uint32
	for _, cap := range keptCaps {
		want[cap>>5] |= 1 << (uint(cap) & 31)
	}
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	data := [2]unix.CapUserData{
		{Permitted: want[0], Effective: want[0], Inheritable: 0},
		{Permitted: want[1], Effective: want[1], Inheritable: 0},
	}
	if _, _, errno := syscall.AllThreadsSyscall(
		unix.SYS_CAPSET,
		uintptr(unsafe.Pointer(&hdr)),
		uintptr(unsafe.Pointer(&data[0])),
		0,
	); errno != 0 {
		return fmt.Errorf("capset: %w", errno)
	}

	// no_new_privs makes the empty bounding set permanent across exec of
	// setuid/file-caps binaries. Nothing this daemon runs needs privilege
	// escalation (it execs nothing at all post-mount).
	if _, _, errno := syscall.AllThreadsSyscall(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0); errno != 0 {
		return fmt.Errorf("PR_SET_NO_NEW_PRIVS: %w", errno)
	}

	return verifyNarrowed()
}

// EINVAL means "this kernel has no capability with that number" (cap_last_cap
// overestimated, which the fallback in capLastCap deliberately does) and is
// fine; anything else — EPERM above all — means the drop is not happening.
func capBoundingDropAllThreads(cap int) error {
	_, _, errno := syscall.AllThreadsSyscall(unix.SYS_PRCTL, unix.PR_CAPBSET_DROP, uintptr(cap), 0)
	if errno == 0 || errno == unix.EINVAL {
		return nil
	}
	return errno
}

// Verification, not decoration (the same stance as agent-init's uid-drop
// check): re-read what the kernel now says, because a narrowing that
// silently didn't take is worse than one that loudly failed.
func verifyNarrowed() error {
	if r1, _, errno := syscall.AllThreadsSyscall(unix.SYS_PRCTL, unix.PR_CAPBSET_READ, uintptr(unix.CAP_SYS_ADMIN), 0); errno != 0 {
		return fmt.Errorf("PR_CAPBSET_READ: %w", errno)
	} else if r1 != 0 {
		return fmt.Errorf("CAP_SYS_ADMIN still in the bounding set after the drop")
	}
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	if err := unix.Capget(&hdr, &data[0]); err != nil {
		return fmt.Errorf("capget: %w", err)
	}
	sysAdminBit := uint32(1) << (uint(unix.CAP_SYS_ADMIN) & 31)
	if data[unix.CAP_SYS_ADMIN>>5].Effective&sysAdminBit != 0 {
		return fmt.Errorf("CAP_SYS_ADMIN still in the effective set after capset")
	}
	return nil
}
