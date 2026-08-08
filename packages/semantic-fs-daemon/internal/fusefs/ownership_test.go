package fusefs

import (
	"os"
	"path/filepath"
	"testing"
)

// chown(2) to an arbitrary gid needs privilege, which a CI runner does not
// have — but chown to a group the process is already in is always permitted,
// so every test here uses a gid this process already belongs to. What is
// being asserted is the mode arithmetic and the walk, not the kernel's chown
// rules.
//
// Gid 0 is unusable here: it is the documented "leave ownership alone" value
// (BERTH_SHARED_GID=0), so a test running as root with no other group would
// be asserting against a deliberate no-op. Skipping says that out loud rather
// than failing for a reason that isn't a defect.
func testGid(t *testing.T) int {
	t.Helper()
	if gid := os.Getgid(); gid > 0 {
		return gid
	}
	groups, err := os.Getgroups()
	if err == nil {
		for _, gid := range groups {
			if gid > 0 {
				return gid
			}
		}
	}
	t.Skip("this process belongs to no non-zero group, so there is no gid it may chown to")
	return 0
}

func TestApplyAddsGroupBitsMirroringOwnerBits(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "note.md")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	newOwnership(testGid(t)).apply(file, false)

	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o660 {
		t.Fatalf("mode = %#o, want 0660 — a non-root app in the shared group cannot write %s", got, file)
	}
}

// The setgid bit is the load-bearing part: without it a subdirectory created
// later inherits the daemon's own gid, not the shared one, and the next app to
// write beneath it gets EACCES for a reason nothing points at.
func TestApplyMakesDirectoriesSetgid(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "agent-runs")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}

	newOwnership(testGid(t)).apply(sub, true)

	info, err := os.Stat(sub)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSetgid == 0 {
		t.Fatalf("mode = %v, want the setgid bit set", info.Mode())
	}
	if got := info.Mode().Perm(); got != 0o770 {
		t.Fatalf("mode = %#o, want 0770", got)
	}
}

// A file the creator deliberately left read-only for its owner stays
// read-only for the group. The group bits mirror the owner's rather than
// being hardcoded to 0660.
func TestApplyDoesNotWidenBeyondTheOwnerBits(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "frozen")
	if err := os.WriteFile(file, []byte("x"), 0o400); err != nil {
		t.Fatal(err)
	}
	// WriteFile's mode is masked by the process umask; set it explicitly so
	// this asserts the mirror rather than the runner's umask.
	if err := os.Chmod(file, 0o400); err != nil {
		t.Fatal(err)
	}

	newOwnership(testGid(t)).apply(file, false)

	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o440 {
		t.Fatalf("mode = %#o, want 0440 — group must not gain write the owner doesn't have", got)
	}
}

// Zero means "leave ownership alone", which is what a standalone run outside
// a Berth image gets. It must be a true no-op, not a chmod to something.
func TestApplyIsANoOpWithoutASharedGid(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "untouched")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	newOwnership(0).apply(file, false)

	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %#o, want it left at 0600", got)
	}
}

// The upgrade path: /var/berth is a persistent volume, so a container that
// boots with this change finds a tree of files created by the previous
// version. If Normalize misses them, checkpoints written before the upgrade
// become unwritable for a non-root app, which presents as silent save
// failures rather than as anything pointing at ownership.
func TestNormalizeReachesFilesNestedInAnExistingTree(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "sessions", "run-1")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	// Deliberately world-readable to start with — a tree created by the
	// previous version of this daemon, under whatever umask it had. Normalize
	// must take the world bits off, not just add group ones.
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(nested, "checkpoint.json")
	if err := os.WriteFile(deep, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	Normalize(root, testGid(t))

	for _, path := range []string{root, filepath.Join(root, "sessions"), nested} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&os.ModeSetgid == 0 || info.Mode().Perm() != 0o770 {
			t.Fatalf("%s: mode = %v, want 0770 with setgid", path, info.Mode())
		}
	}
	info, err := os.Stat(deep)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o660 {
		t.Fatalf("%s: mode = %#o, want 0660", deep, got)
	}
}
