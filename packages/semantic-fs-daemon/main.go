// Command semantic-fs-daemon mounts Berth's Phase 4 semantic filesystem — a
// FUSE passthrough at BERTH_CONTEXT_MOUNT (default /context), backed by a
// real directory, with writes tracked in a SQLite metadata index and
// queryable over a Unix control socket. See docs/semantic-fs-reference.md
// for the full design and the (verified, unlike Phase 3's Landlock gap)
// FUSE-in-Docker-Desktop support this relies on.
package main

import (
	"log"
	"os"
	"strconv"

	"bazil.org/fuse"
	"bazil.org/fuse/fs"

	"berth/semantic-fs-daemon/internal/control"
	"berth/semantic-fs-daemon/internal/fusefs"
	"berth/semantic-fs-daemon/internal/index"
)

// Gid of the shared `berth` group every resident app joins (base.Dockerfile
// creates it, entrypoint.sh adds each app's user to it). Overridable so a
// standalone run outside a Berth image can set BERTH_SHARED_GID=0 and get
// today's root-owned behaviour back.
const defaultSharedGid = 9999

func getenv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func sharedGid() int {
	raw := os.Getenv("BERTH_SHARED_GID")
	if raw == "" {
		return defaultSharedGid
	}
	gid, err := strconv.Atoi(raw)
	if err != nil {
		log.Printf("[semantic-fs] WARNING: BERTH_SHARED_GID=%q is not a number — falling back to %d", raw, defaultSharedGid)
		return defaultSharedGid
	}
	return gid
}

func main() {
	mountPoint := getenv("BERTH_CONTEXT_MOUNT", "/context")
	dataDir := getenv("BERTH_CONTEXT_DATA", "/var/berth/context-data")
	dbPath := getenv("BERTH_CONTEXT_INDEX_DB", "/var/berth/context-index.db")
	socketPath := getenv("BERTH_SEMANTIC_FS_SOCKET", "/tmp/berth-semantic-fs.sock")

	gid := sharedGid()

	for _, dir := range []string{dataDir, mountPoint} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("[semantic-fs] mkdir %s: %v", dir, err)
		}
	}
	// Backing tree only. The mount point's own mode is irrelevant once
	// something is mounted over it — what a caller sees there is the backing
	// root's attributes, which this pass sets.
	fusefs.Normalize(dataDir, gid)

	idx, err := index.Open(dbPath)
	if err != nil {
		log.Fatalf("[semantic-fs] open index: %v", err)
	}
	defer idx.Close()

	registry := control.NewPidRegistry()

	go func() {
		if err := control.Serve(socketPath, idx, registry); err != nil {
			log.Fatalf("[semantic-fs] control socket: %v", err)
		}
	}()

	// AllowOther and DefaultPermissions are a pair, and shipping either one
	// alone would be a mistake in opposite directions (Blocker 2 of
	// docs/per-app-uid-design.md).
	//
	// Without allow_other, a FUSE mount is accessible *only to the mounting
	// uid* — the kernel refuses every other uid at the VFS layer, before any
	// of this daemon's logic runs. So the moment resident apps stop being
	// root, /context would simply vanish for all of them: every checkpoint,
	// session, trace, and apps/filesystem's four *_context_file exports.
	//
	// But allow_other on its own means the kernel does *no* permission
	// checking at all (bazil's own doc on DefaultPermissions says so) and
	// leaves it to the node implementation, which this passthrough does not
	// do — that would open /context to every uid in the container
	// unconditionally, making the ownership work in ownership.go decorative.
	// default_permissions puts the kernel back in charge, evaluating the
	// backing file's mode against the caller: root:berth 0660, so every app
	// in the shared group and nothing else.
	conn, err := fuse.Mount(
		mountPoint,
		fuse.FSName("berth-semantic-fs"),
		fuse.Subtype("berthctx"),
		fuse.AllowOther(),
		fuse.DefaultPermissions(),
	)
	if err != nil {
		log.Fatalf("[semantic-fs] mount %s: %v", mountPoint, err)
	}
	defer conn.Close()

	log.Printf("[semantic-fs] mounted at %s (backing dir %s, shared gid %d), control socket %s", mountPoint, dataDir, gid, socketPath)

	filesystem := fusefs.New(dataDir, idx, registry, gid)
	if err := fs.Serve(conn, filesystem); err != nil {
		log.Fatalf("[semantic-fs] serve: %v", err)
	}
}
