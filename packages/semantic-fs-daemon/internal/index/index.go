// Package index is the metadata sidecar for the semantic filesystem: a
// SQLite table keyed by path, holding the "created_by / task / related_apps"
// metadata the PRD describes. A sidecar index was chosen over real extended
// attributes because xattrs would have to round-trip through the FUSE
// getxattr/setxattr calls on every read, and because SQL is what the query
// API (Phase 4's actual deliverable — "find files related to X") needs
// regardless of where the raw values live. modernc.org/sqlite is a pure-Go
// (no cgo) SQLite so this cross-compiles the same way agent-init and
// context-bus-daemon's Rust binaries do: one static binary, no C toolchain
// baked into the final image.
package index

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type FileMeta struct {
	Path        string   `json:"path"`
	CreatedBy   string   `json:"created_by,omitempty"`
	Task        string   `json:"task,omitempty"`
	RelatedApps []string `json:"related_apps,omitempty"`
	CreatedAt   int64    `json:"created_at"`
	UpdatedAt   int64    `json:"updated_at"`
}

type Index struct {
	db *sql.DB
}

func Open(dbPath string) (*Index, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open index db: %w", err)
	}
	// The daemon is single-process but serves concurrent FUSE requests on
	// separate goroutines; cap to one open connection so SQLite's own
	// file-level locking never has to arbitrate between two of our own
	// connections.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS files (
			path TEXT PRIMARY KEY,
			created_by TEXT NOT NULL DEFAULT '',
			task TEXT NOT NULL DEFAULT '',
			related_apps TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`); err != nil {
		return nil, fmt.Errorf("create files table: %w", err)
	}

	return &Index{db: db}, nil
}

func (idx *Index) Close() error {
	return idx.db.Close()
}

// RecordWrite upserts a row for path, setting created_by only on first
// insert (a later write from a different app shouldn't steal authorship —
// PRD's "created_by" describes who authored the file, not who last touched it).
func (idx *Index) RecordWrite(path, createdBy string) error {
	now := time.Now().Unix()
	_, err := idx.db.Exec(`
		INSERT INTO files (path, created_by, related_apps, created_at, updated_at)
		VALUES (?, ?, '[]', ?, ?)
		ON CONFLICT(path) DO UPDATE SET updated_at = excluded.updated_at
	`, path, createdBy, now, now)
	return err
}

func (idx *Index) Remove(path string) error {
	_, err := idx.db.Exec(`DELETE FROM files WHERE path = ?`, path)
	return err
}

func (idx *Index) Rename(oldPath, newPath string) error {
	_, err := idx.db.Exec(`UPDATE files SET path = ? WHERE path = ?`, newPath, oldPath)
	return err
}

// Tag attaches task/related_apps metadata to an already-written file. Called
// explicitly by resident apps via the SDK (ctx.semanticFs.tag) — unlike
// created_by, which the daemon infers automatically from the writing
// process's pid, "task" and "related_apps" are semantic judgments only the
// calling app can make.
func (idx *Index) Tag(path, task string, relatedApps []string) error {
	relatedJSON, err := json.Marshal(relatedApps)
	if err != nil {
		return fmt.Errorf("marshal related_apps: %w", err)
	}
	now := time.Now().Unix()
	res, err := idx.db.Exec(`
		UPDATE files SET task = ?, related_apps = ?, updated_at = ? WHERE path = ?
	`, task, string(relatedJSON), now, path)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		// Tagging a path the daemon hasn't observed a write for yet (e.g. a
		// file written before the daemon started) — insert rather than
		// silently drop the tag.
		_, err = idx.db.Exec(`
			INSERT INTO files (path, created_by, task, related_apps, created_at, updated_at)
			VALUES (?, '', ?, ?, ?, ?)
		`, path, task, string(relatedJSON), now, now)
		return err
	}
	return nil
}

// Query is a v0 keyword-overlap ranker, not semantic/embedding search: it
// lowercases the query into words and scores each row by how many of those
// words appear (as substrings) in its path, task, created_by, or
// related_apps. That's enough to satisfy the PRD's milestone ("find files
// related to the auth bug" over a handful of tagged fixtures) without
// pulling in an embedding model — a real ranking model is future work, not
// required to prove the primitive.
func (idx *Index) Query(text string, limit int) ([]FileMeta, error) {
	words := strings.Fields(strings.ToLower(text))
	if len(words) == 0 {
		return nil, nil
	}

	rows, err := idx.db.Query(`SELECT path, created_by, task, related_apps, created_at, updated_at FROM files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type scored struct {
		meta  FileMeta
		score int
	}
	var candidates []scored

	for rows.Next() {
		var (
			m           FileMeta
			relatedJSON string
		)
		if err := rows.Scan(&m.Path, &m.CreatedBy, &m.Task, &relatedJSON, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(relatedJSON), &m.RelatedApps)

		haystack := strings.ToLower(m.Path + " " + m.CreatedBy + " " + m.Task + " " + strings.Join(m.RelatedApps, " "))
		score := 0
		for _, w := range words {
			if strings.Contains(haystack, w) {
				score++
			}
		}
		if score > 0 {
			candidates = append(candidates, scored{meta: m, score: score})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := 1; i < len(candidates); i++ {
		for j := i; j > 0 && candidates[j].score > candidates[j-1].score; j-- {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
		}
	}

	if limit <= 0 || limit > len(candidates) {
		limit = len(candidates)
	}
	results := make([]FileMeta, limit)
	for i := 0; i < limit; i++ {
		results[i] = candidates[i].meta
	}
	return results, nil
}
