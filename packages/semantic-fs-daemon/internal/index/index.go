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

	// Sidecar, not a column on files: re-embedding (e.g. a model upgrade)
	// shouldn't require rewriting the hot files table. No FK cascade is
	// enabled (modernc.org/sqlite doesn't enforce `REFERENCES` without a
	// pragma this code doesn't set), so Remove()/Rename() keep this in sync
	// by hand.
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS files_vec (
			path TEXT PRIMARY KEY,
			embedding BLOB NOT NULL,
			model TEXT NOT NULL,
			dim INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`); err != nil {
		return nil, fmt.Errorf("create files_vec table: %w", err)
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
	if _, err := idx.db.Exec(`DELETE FROM files_vec WHERE path = ?`, path); err != nil {
		return err
	}
	_, err := idx.db.Exec(`DELETE FROM files WHERE path = ?`, path)
	return err
}

func (idx *Index) Rename(oldPath, newPath string) error {
	if _, err := idx.db.Exec(`UPDATE files_vec SET path = ? WHERE path = ?`, newPath, oldPath); err != nil {
		return err
	}
	_, err := idx.db.Exec(`UPDATE files SET path = ? WHERE path = ?`, newPath, oldPath)
	return err
}

// SetEmbedding upserts path's embedding vector. Called after a successful
// Tag() when the caller (the SDK's tag() control call) supplied one —
// embeddings are an enhancement, not a correctness requirement, so a failure
// here is logged by the caller and never turns a working Tag() into a
// failure for the app.
func (idx *Index) SetEmbedding(path string, embedding []float32, model string) error {
	now := time.Now().Unix()
	_, err := idx.db.Exec(`
		INSERT INTO files_vec (path, embedding, model, dim, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET embedding = excluded.embedding, model = excluded.model, dim = excluded.dim, updated_at = excluded.updated_at
	`, path, encodeEmbedding(embedding), model, len(embedding), now)
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

// embeddingMatchThreshold is the minimum cosine similarity for a purely
// semantic match (zero keyword overlap) to be included at all — without
// this, a row with keywordScore == 0 would never surface no matter how
// semantically close it is, defeating the point of adding embeddings.
// Calibrated by hand against real MiniLM output for this SDK's actual
// embedding input shape (short "task + relatedApps + path" strings, not full
// sentences): a genuinely related pair scored ~0.30 cosine similarity, an
// unrelated pair in the same short/tag-like style scored ~0.04 — 0.2 sits
// well clear of both, rather than being picked to make one example pass.
const embeddingMatchThreshold = 0.2

// Query hybridizes v0's keyword-overlap ranking with optional embedding
// similarity: it lowercases the query into words and scores each row by how
// many appear (as substrings) in its path, task, created_by, or
// related_apps, AND — when the caller supplied a queryEmbedding and a row
// has a stored embedding from the SAME model — adds a cosine-similarity
// term. Keyword hits (small integers) dominate ranking over the 0-1 cosine
// range, so exact-name/author lookups still win, while purely-semantic
// matches (keywordScore 0) rank among themselves by cosine. A row is only
// dropped if it has NEITHER a keyword hit NOR a strong-enough embedding
// match — v0 dropped every zero-keyword-hit row outright, which would
// silently discard exactly the matches embeddings exist to surface.
func (idx *Index) Query(text string, queryEmbedding []float32, queryModel string, limit int) ([]FileMeta, error) {
	words := strings.Fields(strings.ToLower(text))
	if len(words) == 0 && len(queryEmbedding) == 0 {
		return nil, nil
	}

	rows, err := idx.db.Query(`
		SELECT f.path, f.created_by, f.task, f.related_apps, f.created_at, f.updated_at, v.embedding, v.model
		FROM files f LEFT JOIN files_vec v ON v.path = f.path
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type scored struct {
		meta  FileMeta
		score float64
	}
	var candidates []scored

	for rows.Next() {
		var (
			m              FileMeta
			relatedJSON    string
			embeddingBytes []byte
			model          sql.NullString
		)
		if err := rows.Scan(&m.Path, &m.CreatedBy, &m.Task, &relatedJSON, &m.CreatedAt, &m.UpdatedAt, &embeddingBytes, &model); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(relatedJSON), &m.RelatedApps)

		haystack := strings.ToLower(m.Path + " " + m.CreatedBy + " " + m.Task + " " + strings.Join(m.RelatedApps, " "))
		keywordScore := 0
		for _, w := range words {
			if strings.Contains(haystack, w) {
				keywordScore++
			}
		}

		cosineSim := 0.0
		if len(queryEmbedding) > 0 && len(embeddingBytes) > 0 && model.Valid && model.String == queryModel {
			cosineSim = cosineSimilarity(queryEmbedding, decodeEmbedding(embeddingBytes))
		}

		if keywordScore > 0 || cosineSim >= embeddingMatchThreshold {
			candidates = append(candidates, scored{meta: m, score: float64(keywordScore) + cosineSim})
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
