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

	"bazil.org/fuse"
	"bazil.org/fuse/fs"

	"berth/semantic-fs-daemon/internal/control"
	"berth/semantic-fs-daemon/internal/fusefs"
	"berth/semantic-fs-daemon/internal/index"
)

func getenv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	mountPoint := getenv("BERTH_CONTEXT_MOUNT", "/context")
	dataDir := getenv("BERTH_CONTEXT_DATA", "/var/berth/context-data")
	dbPath := getenv("BERTH_CONTEXT_INDEX_DB", "/var/berth/context-index.db")
	socketPath := getenv("BERTH_SEMANTIC_FS_SOCKET", "/tmp/berth-semantic-fs.sock")

	for _, dir := range []string{dataDir, mountPoint} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("[semantic-fs] mkdir %s: %v", dir, err)
		}
	}

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

	conn, err := fuse.Mount(
		mountPoint,
		fuse.FSName("berth-semantic-fs"),
		fuse.Subtype("berthctx"),
	)
	if err != nil {
		log.Fatalf("[semantic-fs] mount %s: %v", mountPoint, err)
	}
	defer conn.Close()

	log.Printf("[semantic-fs] mounted at %s (backing dir %s), control socket %s", mountPoint, dataDir, socketPath)

	filesystem := fusefs.New(dataDir, idx, registry)
	if err := fs.Serve(conn, filesystem); err != nil {
		log.Fatalf("[semantic-fs] serve: %v", err)
	}
}
