// Package fusefs is a FUSE passthrough filesystem: every read/write it
// serves is forwarded verbatim to a real backing directory on disk (so
// resident apps see ordinary POSIX file semantics), while every write also
// updates the sidecar metadata index (internal/index) — created_by is
// inferred automatically from the writing process's pid via the control
// socket's pid->app registry, so a resident app gets attribution for free
// just by writing through /context like any other path.
package fusefs

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"syscall"

	"bazil.org/fuse"
	"bazil.org/fuse/fs"

	"berth/semantic-fs-daemon/internal/control"
	"berth/semantic-fs-daemon/internal/index"
)

type FS struct {
	dataDir  string
	idx      *index.Index
	registry *control.PidRegistry
	// Shared-group ownership for everything this filesystem creates. See
	// ownership.go — pass 0 for "leave ownership alone", which is what any
	// run outside a Berth image gets.
	owner *ownership
}

func New(dataDir string, idx *index.Index, registry *control.PidRegistry, sharedGid int) *FS {
	return &FS{dataDir: dataDir, idx: idx, registry: registry, owner: newOwnership(sharedGid)}
}

func (f *FS) Root() (fs.Node, error) {
	return &Dir{fs: f, real: f.dataDir}, nil
}

// relPath is what actually gets stored/queried in the index — real,
// absolute backing-store paths would leak the container's internal layout
// into query results and break comparisons after a daemon restart with a
// different data dir.
func (f *FS) relPath(real string) string {
	rel, err := filepath.Rel(f.dataDir, real)
	if err != nil {
		return real
	}
	return rel
}

func (f *FS) recordWrite(realPath string, pid uint32, uid uint32) {
	createdBy := f.registry.Attribute(int(pid), uid)
	rel := f.relPath(realPath)
	if err := f.idx.RecordWrite(rel, createdBy); err != nil {
		log.Printf("[semantic-fs] index write for %q failed: %v", rel, err)
	}
}

type Dir struct {
	fs   *FS
	real string
}

var (
	_ fs.Node                 = (*Dir)(nil)
	_ fs.NodeStringLookuper   = (*Dir)(nil)
	_ fs.HandleReadDirAller   = (*Dir)(nil)
	_ fs.NodeCreater          = (*Dir)(nil)
	_ fs.NodeMkdirer          = (*Dir)(nil)
	_ fs.NodeRemover          = (*Dir)(nil)
	_ fs.NodeRenamer          = (*Dir)(nil)
)

func (d *Dir) Attr(ctx context.Context, a *fuse.Attr) error {
	return statAttr(d.real, a)
}

func (d *Dir) Lookup(ctx context.Context, name string) (fs.Node, error) {
	full := filepath.Join(d.real, name)
	info, err := os.Lstat(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, syscall.ENOENT
		}
		return nil, err
	}
	if info.IsDir() {
		return &Dir{fs: d.fs, real: full}, nil
	}
	return &File{fs: d.fs, real: full}, nil
}

func (d *Dir) ReadDirAll(ctx context.Context) ([]fuse.Dirent, error) {
	entries, err := os.ReadDir(d.real)
	if err != nil {
		return nil, err
	}
	dirents := make([]fuse.Dirent, 0, len(entries))
	for _, entry := range entries {
		typ := fuse.DT_File
		if entry.IsDir() {
			typ = fuse.DT_Dir
		}
		dirents = append(dirents, fuse.Dirent{Name: entry.Name(), Type: typ})
	}
	return dirents, nil
}

func (d *Dir) Create(ctx context.Context, req *fuse.CreateRequest, resp *fuse.CreateResponse) (fs.Node, fs.Handle, error) {
	full := filepath.Join(d.real, req.Name)
	mode := req.Mode.Perm()
	if mode == 0 {
		mode = 0644
	}
	osFile, err := os.OpenFile(full, os.O_CREATE|os.O_RDWR|os.O_TRUNC, mode)
	if err != nil {
		return nil, nil, err
	}
	d.fs.owner.apply(full, false)

	d.fs.recordWrite(full, req.Pid, req.Uid)

	node := &File{fs: d.fs, real: full}
	return node, &FileHandle{fs: d.fs, file: osFile, node: node}, nil
}

func (d *Dir) Mkdir(ctx context.Context, req *fuse.MkdirRequest) (fs.Node, error) {
	full := filepath.Join(d.real, req.Name)
	mode := req.Mode.Perm()
	if mode == 0 {
		mode = 0755
	}
	if err := os.Mkdir(full, mode); err != nil {
		return nil, err
	}
	d.fs.owner.apply(full, true)
	return &Dir{fs: d.fs, real: full}, nil
}

func (d *Dir) Remove(ctx context.Context, req *fuse.RemoveRequest) error {
	full := filepath.Join(d.real, req.Name)
	if err := os.Remove(full); err != nil {
		return err
	}
	if !req.Dir {
		_ = d.fs.idx.Remove(d.fs.relPath(full))
	}
	return nil
}

func (d *Dir) Rename(ctx context.Context, req *fuse.RenameRequest, newDir fs.Node) error {
	newDirNode, ok := newDir.(*Dir)
	if !ok {
		return syscall.EIO
	}
	oldFull := filepath.Join(d.real, req.OldName)
	newFull := filepath.Join(newDirNode.real, req.NewName)
	if err := os.Rename(oldFull, newFull); err != nil {
		return err
	}
	_ = d.fs.idx.Rename(d.fs.relPath(oldFull), d.fs.relPath(newFull))
	return nil
}

type File struct {
	fs   *FS
	real string
}

var (
	_ fs.Node          = (*File)(nil)
	_ fs.NodeOpener    = (*File)(nil)
	_ fs.NodeSetattrer = (*File)(nil)
)

func (f *File) Attr(ctx context.Context, a *fuse.Attr) error {
	return statAttr(f.real, a)
}

// Open always opens the backing file O_RDWR regardless of the requested
// flags: this daemon runs as the container's root user, so a simpler
// blanket-RDWR open is enough to serve read, write, and read-write callers
// correctly. The access check that decides whether a caller was allowed to
// ask has already happened by the time this runs — the mount sets
// `default_permissions` (main.go), so the kernel evaluates the backing file's
// mode against the calling uid before the request reaches this daemon at all.
func (f *File) Open(ctx context.Context, req *fuse.OpenRequest, resp *fuse.OpenResponse) (fs.Handle, error) {
	osFile, err := os.OpenFile(f.real, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	return &FileHandle{fs: f.fs, file: osFile, node: f}, nil
}

func (f *File) Setattr(ctx context.Context, req *fuse.SetattrRequest, resp *fuse.SetattrResponse) error {
	if req.Valid.Size() {
		if err := os.Truncate(f.real, int64(req.Size)); err != nil {
			return err
		}
		f.fs.recordWrite(f.real, req.Pid, req.Uid)
	}
	return statAttr(f.real, &resp.Attr)
}

type FileHandle struct {
	fs   *FS
	file *os.File
	node *File
}

var (
	_ fs.HandleReader   = (*FileHandle)(nil)
	_ fs.HandleWriter   = (*FileHandle)(nil)
	_ fs.HandleFlusher  = (*FileHandle)(nil)
	_ fs.HandleReleaser = (*FileHandle)(nil)
)

func (h *FileHandle) Read(ctx context.Context, req *fuse.ReadRequest, resp *fuse.ReadResponse) error {
	buf := make([]byte, req.Size)
	n, err := h.file.ReadAt(buf, req.Offset)
	if err != nil && err != io.EOF {
		return err
	}
	resp.Data = buf[:n]
	return nil
}

func (h *FileHandle) Write(ctx context.Context, req *fuse.WriteRequest, resp *fuse.WriteResponse) error {
	n, err := h.file.WriteAt(req.Data, req.Offset)
	if err != nil {
		return err
	}
	resp.Size = n
	h.fs.recordWrite(h.node.real, req.Pid, req.Uid)
	return nil
}

func (h *FileHandle) Flush(ctx context.Context, req *fuse.FlushRequest) error {
	return h.file.Sync()
}

func (h *FileHandle) Release(ctx context.Context, req *fuse.ReleaseRequest) error {
	return h.file.Close()
}

func statAttr(real string, a *fuse.Attr) error {
	info, err := os.Lstat(real)
	if err != nil {
		if os.IsNotExist(err) {
			return syscall.ENOENT
		}
		return err
	}
	a.Size = uint64(info.Size())
	a.Mode = info.Mode()
	a.Mtime = info.ModTime()
	a.Ctime = info.ModTime()
	a.Atime = info.ModTime()
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		a.Inode = stat.Ino
		a.Uid = stat.Uid
		a.Gid = stat.Gid
	}
	return nil
}
