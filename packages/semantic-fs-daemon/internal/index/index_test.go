package index

import (
	"path/filepath"
	"sync"
	"testing"
)

func openTestIndex(t *testing.T) *Index {
	t.Helper()
	dir := t.TempDir()
	idx, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		_ = idx.Close()
	})
	return idx
}

func TestTagInsertsWhenNoPriorWriteRecorded(t *testing.T) {
	idx := openTestIndex(t)

	if err := idx.Tag("/context/notes/a.md", "research", []string{"notes"}); err != nil {
		t.Fatalf("Tag: %v", err)
	}

	metas, err := idx.Query("research", nil, "", 10)
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(metas) != 1 || metas[0].Path != "/context/notes/a.md" || metas[0].Task != "research" {
		t.Fatalf("expected a tagged row, got %+v", metas)
	}
}

func TestTagUpdatesExistingRowWithoutTouchingCreatedBy(t *testing.T) {
	idx := openTestIndex(t)

	if err := idx.RecordWrite("/context/notes/a.md", "notes-app"); err != nil {
		t.Fatalf("RecordWrite: %v", err)
	}
	if err := idx.Tag("/context/notes/a.md", "research", []string{"notes"}); err != nil {
		t.Fatalf("Tag: %v", err)
	}

	metas, err := idx.Query("research", nil, "", 10)
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(metas) != 1 || metas[0].CreatedBy != "notes-app" || metas[0].Task != "research" {
		t.Fatalf("expected created_by preserved and task set, got %+v", metas)
	}
}

// Regression test for a TOCTOU race: Tag() used to run a separate UPDATE,
// then a conditional INSERT only when RowsAffected() == 0 — two independent
// statements with no transaction spanning them. Two goroutines calling
// Tag() concurrently on the same never-before-seen path (e.g. a
// pre-existing file the daemon never recorded a write for) could both see
// 0 rows affected from the UPDATE and both attempt the INSERT, one hitting
// a raw `UNIQUE constraint failed: files.path` error for a completely
// legitimate, non-conflicting operation. Confirmed empirically before the
// fix: ~94% failure rate across 50 runs of two concurrent calls. The fix
// (a single INSERT ... ON CONFLICT statement) makes this atomic.
func TestTagIsSafeUnderConcurrentCallsOnTheSameUntaggedPath(t *testing.T) {
	idx := openTestIndex(t)

	const goroutines = 20
	var wg sync.WaitGroup
	errs := make([]error, goroutines)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = idx.Tag("/context/shared/path.md", "shared-task", []string{"app-a", "app-b"})
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: Tag returned an error: %v", i, err)
		}
	}

	metas, err := idx.Query("shared-task", nil, "", 10)
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(metas) != 1 {
		t.Fatalf("expected exactly one row for the shared path, got %d: %+v", len(metas), metas)
	}
}
