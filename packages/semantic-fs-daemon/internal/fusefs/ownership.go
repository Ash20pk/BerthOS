package fusefs

import (
	"log"
	"os"
	"sync"
)

// SharedGroupGid is the gid every resident app carries as a supplementary
// group (`berth`, gid 9999 — created in base.Dockerfile, joined per app by
// entrypoint.sh). Backing files are created owned by it so that /context
// survives an app process that is no longer uid 0.
//
// This is the whole of Blocker 3 in docs/per-app-uid-design.md, and it comes
// with the cost that document states plainly: group ownership is shared by
// *every* app, so /context is a deliberate exception to "each app is isolated
// from the others" rather than a place where the uid split buys isolation.
// Per-writer enforcement is REMEDIATION.md 1.14's SO_PEERCRED work; what the
// index records today (`created_by`, from the pid registry) is attribution
// only, and an app can already write another app's files here.
//
// Zero disables the whole mechanism, which is what any unit test and any
// standalone run outside a Berth image gets — there is no `berth` group there
// to chown to, and failing a write because of that would be worse than
// leaving ownership alone.
type ownership struct {
	gid int
	// chown(2) on a backing file fails for every file once it fails for one
	// (a missing group, a filesystem that doesn't support it), and the FUSE
	// layer is on the hot path of every write. Log the first failure and
	// stay quiet after that rather than emitting one line per file.
	warnOnce sync.Once
}

func newOwnership(gid int) *ownership {
	return &ownership{gid: gid}
}

// apply gives a freshly created backing file or directory the shared group,
// and the group bits to go with it: rw for a file, rwx + setgid for a
// directory. The setgid bit is what makes this stick — without it, a
// subdirectory created later inherits the *daemon's* gid rather than the
// shared one, and the next app to write under it gets EACCES.
//
// Group bits mirror the owner's rather than being hardcoded to 0660/2770, so
// a caller that deliberately created something read-only keeps it read-only
// for the group too. World bits are cleared in the same step: /context holds
// agent context, checkpoints, and traces, and the point of the shared group
// is that membership is what grants access. Nothing loses reachability by
// this — root is exempt from mode checks, and every app is in the group.
func (o *ownership) apply(path string, isDir bool) {
	if o == nil || o.gid <= 0 {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		o.warn("stat", path, err)
		return
	}
	owner := info.Mode().Perm() & 0o700
	mode := os.FileMode(owner | owner>>3)
	if isDir {
		mode |= os.ModeSetgid
	}
	if err := os.Chown(path, -1, o.gid); err != nil {
		o.warn("chown", path, err)
		return
	}
	// After the chown, never before: chown(2) clears the setgid bit on some
	// filesystems, so setting the mode first would silently lose it.
	if err := os.Chmod(path, mode); err != nil {
		o.warn("chmod", path, err)
	}
}

func (o *ownership) warn(op, path string, err error) {
	o.warnOnce.Do(func() {
		log.Printf("[semantic-fs] WARNING: %s %q for shared group %d failed (%v) — /context will not be writable by a non-root app; further occurrences are not logged", op, path, o.gid, err)
	})
}

// Normalize walks an existing backing directory and applies the shared group
// to everything already in it. Without this, a container upgraded in place —
// /var/berth is a persistent volume — keeps a tree of root:root 0644 files
// that the kernel (this mount now sets `default_permissions`) refuses to let
// a non-root app write, which would present as checkpoints silently failing
// to save rather than as anything pointing here.
func Normalize(dataDir string, gid int) {
	if gid <= 0 {
		return
	}
	o := newOwnership(gid)
	var walk func(string)
	walk = func(dir string) {
		o.apply(dir, true)
		entries, err := os.ReadDir(dir)
		if err != nil {
			o.warn("readdir", dir, err)
			return
		}
		for _, entry := range entries {
			full := dir + "/" + entry.Name()
			if entry.IsDir() {
				walk(full)
				continue
			}
			o.apply(full, false)
		}
	}
	walk(dataDir)
}
