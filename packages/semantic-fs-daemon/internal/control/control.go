// Package control implements the semantic-fs daemon's control-plane API: a
// Unix socket carrying length-prefixed JSON request/response frames — the
// same 4-byte-BE-length framing context-bus-daemon uses, but JSON instead of
// protobuf. Control calls (register/tag/query) are low-frequency and
// human-readable-payload operations, not the high-throughput event stream
// the context bus is; protobuf's schema ceremony isn't worth it here.
package control

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"

	"berth/semantic-fs-daemon/internal/index"
)

// Largest control frame this daemon will allocate for. Control calls are
// register/tag/query with small JSON payloads — an embedding vector is the
// biggest thing on the wire — so 8 MiB is orders of magnitude above real
// traffic and still refuses the 4 GiB a 0xFFFFFFFF length header used to
// reserve. Same ceiling as context-bus-daemon's MAX_FRAME_BYTES.
const maxFrameBytes = 8 * 1024 * 1024

type request struct {
	ID          string    `json:"id"`
	Op          string    `json:"op"`
	Pid         int       `json:"pid,omitempty"`
	App         string    `json:"app,omitempty"`
	Path        string    `json:"path,omitempty"`
	Task        string    `json:"task,omitempty"`
	RelatedApps []string  `json:"related_apps,omitempty"`
	Text        string    `json:"text,omitempty"`
	Limit       int       `json:"limit,omitempty"`
	Embedding   []float32 `json:"embedding,omitempty"`
	Model       string    `json:"model,omitempty"`
}

type response struct {
	ID      string            `json:"id"`
	OK      bool              `json:"ok"`
	Error   string            `json:"error,omitempty"`
	Results []index.FileMeta  `json:"results,omitempty"`
}

// PidRegistry maps a resident app's OS pid to the app name it registered
// under, so the FUSE layer can attribute a write to "created_by" without the
// caller having to pass its own identity on every single file op.
type PidRegistry struct {
	mu  sync.RWMutex
	pid map[int]string
	// uid -> app name, from BERTH_APP_UID_MAP. The sidecar deployment
	// (BUILD_PLAN M1.1) runs this daemon in a different pid namespace from
	// the apps, where a FUSE request's Pid is untranslatable — but uids are
	// global, each app has its own (10000+index), and the orchestrator that
	// assigns them passes the same mapping here. Empty in-sandbox, where the
	// pid registry keeps working exactly as before.
	uid map[uint32]string
}

func NewPidRegistry() *PidRegistry {
	return &PidRegistry{pid: make(map[int]string), uid: ParseUidMap(os.Getenv("BERTH_APP_UID_MAP"))}
}

// ParseUidMap parses "app-a=10000,app-b=10001" — the orchestrator-declared
// uid assignment, identical to entrypoint.sh's provision_app_identity math.
func ParseUidMap(raw string) map[uint32]string {
	out := make(map[uint32]string)
	for _, pair := range strings.Split(raw, ",") {
		name, uidStr, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok || name == "" {
			continue
		}
		uid, err := strconv.ParseUint(uidStr, 10, 32)
		if err != nil {
			continue
		}
		out[uint32(uid)] = name
	}
	return out
}

// Attribute resolves a FUSE request to an app name: by registered pid where
// the pid namespace is shared (the in-sandbox deployment), by declared uid
// where it is not (the sidecar). Empty when neither knows the caller.
func (r *PidRegistry) Attribute(pid int, uid uint32) string {
	if name := r.Lookup(pid); name != "" {
		return name
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.uid[uid]
}

// AppNameForUid is Attribute's uid half, for peer identification.
func (r *PidRegistry) AppNameForUid(uid uint32) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.uid[uid]
}

func (r *PidRegistry) Register(pid int, app string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pid[pid] = app
}

// Lookup resolves pid to its thread-group id before checking the map. FUSE's
// per-request Header.Pid (at least on this kernel) is the raw kernel task id
// of whichever thread issued the syscall — for Node, that's whichever libuv
// threadpool worker handled the fs call, which varies request to request and
// never matches the tgid (Node's own process.pid) that register() recorded.
// /proc/<pid>/status is readable here because the daemon and every resident
// app share the same container's pid namespace.
func (r *PidRegistry) Lookup(pid int) string {
	tgid := resolveTgid(pid)
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.pid[tgid]
}

func resolveTgid(pid int) int {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return pid
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "Tgid:" {
			if tgid, err := strconv.Atoi(fields[1]); err == nil {
				return tgid
			}
		}
	}
	return pid
}

func Serve(socketPath string, idx *index.Index, registry *PidRegistry, sharedGid int) error {
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", socketPath, err)
	}
	// connect(2) on a pathname socket needs write permission on it, and a
	// socket created under the default umask is 0755 — reachable by root and
	// nobody else. Every app is meant to reach this one (entrypoint.sh:
	// "only the control socket is unconditionally reachable"), so it is given
	// to the shared `berth` group the moment apps stop being root. Failure is
	// logged rather than fatal: on a kernel or image without that group the
	// daemon is still useful to root, and taking the container down over it
	// would be a worse outcome than a control socket only root can reach.
	if sharedGid > 0 {
		if err := os.Chown(socketPath, -1, sharedGid); err != nil {
			log.Printf("[semantic-fs:control] WARNING: chown %s to gid %d failed (%v) — a non-root app cannot reach it", socketPath, sharedGid, err)
		} else if err := os.Chmod(socketPath, 0o660); err != nil {
			log.Printf("[semantic-fs:control] WARNING: chmod %s failed (%v) — a non-root app cannot reach it", socketPath, err)
		}
	}

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("[semantic-fs:control] accept error: %v", err)
			continue
		}
		// SO_PEERCRED, read once per connection rather than per frame: the
		// pid and uid the kernel stamped on it cannot change for its
		// lifetime, and the client cannot influence them. This is what makes
		// a register frame's `pid` and `app` advisory rather than
		// authoritative (REMEDIATION.md 1.14).
		go handleConn(conn, idx, registry, identifyPeer(conn))
	}
}

func handleConn(conn net.Conn, idx *index.Index, registry *PidRegistry, peer peerIdentity) {
	defer conn.Close()
	reader := bufio.NewReader(conn)

	for {
		frame, err := readFrame(reader)
		if err != nil {
			return // EOF or closed — normal when the SDK client disconnects.
		}

		var req request
		if err := json.Unmarshal(frame, &req); err != nil {
			writeFrame(conn, response{OK: false, Error: fmt.Sprintf("invalid request: %v", err)})
			continue
		}

		resp := handle(req, idx, registry, peer)
		if err := writeFrame(conn, resp); err != nil {
			return
		}
	}
}

func handle(req request, idx *index.Index, registry *PidRegistry, peer peerIdentity) response {
	switch req.Op {
	case "register":
		// Both fields of the request are ignored in favour of what the kernel
		// reported for this connection. The pid matters as much as the name:
		// the FUSE layer attributes a write by looking up the writing pid in
		// this registry, so a caller able to register *another* process's pid
		// could attribute its own writes to a different app.
		if peer.contradicts(req.App) {
			log.Printf("[semantic-fs:control] a caller (pid %d, uid %d) registered as %q but the kernel says %q — using the latter",
				peer.pid, peer.uid, req.App, peer.resolveClaim(req.App))
		}
		pid := peer.pid
		if pid == 0 {
			// Credentials unreadable (see identifyPeer). Falling back to the
			// claimed pid is not a widening: without a pid there is nothing to
			// attribute at all, and the name is still the kernel's answer.
			pid = req.Pid
		}
		registry.Register(pid, peer.resolveClaim(req.App))
		return response{ID: req.ID, OK: true}

	case "tag":
		if err := idx.Tag(req.Path, req.Task, req.RelatedApps); err != nil {
			return response{ID: req.ID, OK: false, Error: err.Error()}
		}
		// Embeddings are an enhancement, not a correctness requirement — a
		// failed/absent embedding never turns a working Tag() into a
		// failure for the calling app.
		if len(req.Embedding) > 0 {
			if err := idx.SetEmbedding(req.Path, req.Embedding, req.Model); err != nil {
				log.Printf("[semantic-fs:control] WARNING: failed to store embedding for %q: %v", req.Path, err)
			}
		}
		return response{ID: req.ID, OK: true}

	case "query":
		results, err := idx.Query(req.Text, req.Embedding, req.Model, req.Limit)
		if err != nil {
			return response{ID: req.ID, OK: false, Error: err.Error()}
		}
		return response{ID: req.ID, OK: true, Results: results}

	default:
		return response{ID: req.ID, OK: false, Error: fmt.Sprintf("unknown op %q", req.Op)}
	}
}

func readFrame(reader *bufio.Reader) ([]byte, error) {
	var lengthBuf [4]byte
	if _, err := readFull(reader, lengthBuf[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(lengthBuf[:])
	// Checked before the allocation, which is the whole point: a 4-byte header
	// of 0xFFFFFFFF used to allocate 4 GiB in this daemon, which runs as root
	// outside any Landlock domain and is reachable by every app in the sandbox
	// (REMEDIATION.md 1.14). Returning an error drops the connection — a
	// client that framed one message this badly has no credible next frame on
	// the same stream. Mirrored in context-bus-daemon, which had the identical
	// bug and uses the same ceiling.
	if length > maxFrameBytes {
		return nil, fmt.Errorf("frame length %d exceeds the %d-byte maximum", length, maxFrameBytes)
	}
	frame := make([]byte, length)
	if _, err := readFull(reader, frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func readFull(reader *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := reader.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func writeFrame(conn net.Conn, resp response) error {
	encoded, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	var lengthBuf [4]byte
	binary.BigEndian.PutUint32(lengthBuf[:], uint32(len(encoded)))
	if _, err := conn.Write(lengthBuf[:]); err != nil {
		return err
	}
	_, err = conn.Write(encoded)
	return err
}
