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
}

func NewPidRegistry() *PidRegistry {
	return &PidRegistry{pid: make(map[int]string)}
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

func Serve(socketPath string, idx *index.Index, registry *PidRegistry) error {
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", socketPath, err)
	}

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("[semantic-fs:control] accept error: %v", err)
			continue
		}
		go handleConn(conn, idx, registry)
	}
}

func handleConn(conn net.Conn, idx *index.Index, registry *PidRegistry) {
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

		resp := handle(req, idx, registry)
		if err := writeFrame(conn, resp); err != nil {
			return
		}
	}
}

func handle(req request, idx *index.Index, registry *PidRegistry) response {
	switch req.Op {
	case "register":
		registry.Register(req.Pid, req.App)
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
