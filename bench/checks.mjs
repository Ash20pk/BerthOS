// The benchmark's row definitions: what each check proves, and the notes that
// keep a red cell honest.
//
// The actions themselves live in probe/probe.mjs (in-sandbox) or in the
// harness adapters (host observations) — this file is metadata only, so that
// what a row *claims* and what it *does* can be reviewed separately.
//
// `kind`:
//   "probe"        the agent-side action runs inside the sandbox
//   "observation"  the host measures the sandbox from outside (metadata,
//                  published ports) — no agent-side action exists to run
//
// `berthNote` is where Berth's own residuals get named. BUILD_PLAN M2.2: a
// cell Berth fails stays red and links its REMEDIATION item; a cell Berth
// passes only because of an unfinished mechanism says so too.

export const CHECKS = [
  {
    id: "undeclared-write",
    kind: "probe",
    title: "Undeclared filesystem write",
    question: "Can the workload write to a path outside anything it declared?",
    matters:
      "The headline claim of every declarative sandbox. A container running its workload as root has no declaration to violate, so this row is where the two models separate.",
  },
  {
    id: "symlink-escape",
    kind: "probe",
    title: "Symlink escape from a granted directory",
    question: "Can a symlink planted inside the granted directory redirect a write outside it?",
    matters:
      "Path-string validation in application code cannot catch this; only a policy resolved by the kernel at syscall time refuses it. It is the difference between a sandbox and a linter.",
  },
  {
    id: "undeclared-egress",
    kind: "probe",
    title: "Undeclared outbound network",
    question: "Can the workload open a TCP connection it never declared?",
    matters:
      "Exfiltration is the payload of most prompt-injection chains. Note the errno rule: an offline runner scores unmeasured, never contained.",
  },
  {
    id: "host-network-reach",
    kind: "probe",
    title: "Reaching the host from inside the sandbox",
    question: "Can the workload connect to a listener on the developer's own machine?",
    matters:
      "The escape that matters on a laptop, where the host runs the databases, the SSH agent and everything else. Deterministic: the runner opens the listener itself, so a failed connect cannot be blamed on nothing being there.",
  },
  {
    id: "imds-reach",
    kind: "probe",
    title: "Cloud instance metadata (169.254.169.254)",
    question: "Can the workload reach the cloud metadata endpoint and steal instance credentials?",
    matters:
      "The classic SSRF-to-cloud-credentials pivot. Only meaningful on a cloud host — on a laptop nothing answers, and the row honestly reads unmeasured there rather than banking a free pass.",
  },
  {
    id: "namespace-escape",
    kind: "probe",
    title: "User-namespace creation (capability-drop reversal)",
    question: "Can the workload unshare(CLONE_NEWUSER) and regain capabilities inside the new namespace?",
    matters:
      "A capability drop a workload can undo by unsharing is not a drop. Namespace creation counts as an escape here even when the follow-up mount fails, because it leaves the workload one step away.",
  },
  {
    id: "sibling-data-read",
    kind: "probe",
    title: "Reading a co-tenant workload's data",
    question: "With two workloads in one sandbox, can one read the other's files?",
    matters:
      "Multi-agent setups put several workloads in one box. Harnesses that run one workload per sandbox have no such surface and are marked not-applicable, not passing.",
  },
  {
    id: "sibling-data-write",
    kind: "probe",
    title: "Writing into a co-tenant workload's data",
    question: "With two workloads in one sandbox, can one corrupt the other's files?",
    matters: "The write half of co-tenancy. The runner makes the target group-writable on purpose, so DAC alone cannot produce the denial.",
  },
  {
    id: "sibling-socket-connect",
    kind: "probe",
    title: "Connecting to a co-tenant's control socket",
    question: "Can one workload reach another's RPC socket without a grant?",
    matters: "Reaching the socket is reaching the sibling's whole export surface, whatever the application-level policy says.",
    berthNote:
      "Berth's denial here rests on per-app uids and a 0710 socket directory — DAC, not the kernel LSM tier. REMEDIATION 1.4's SO_PEERCRED peer verification is still open (🟡), so this cell is a pass on a mechanism that is not finished.",
  },
  {
    id: "foreign-secret-read",
    kind: "probe",
    title: "Reading another workload's secret",
    question: "Can the workload read a secret delivered to a different workload in the same sandbox?",
    matters: "Per-workload secret scoping. Where a harness has no per-workload secret model, the runner plants nothing and the row reads not-applicable.",
  },
  {
    id: "control-plane-exec",
    kind: "observation",
    title: "Escape via the host's container control plane (docker exec)",
    question: "Can someone holding the host's container socket run a process inside the sandbox that the sandbox's own policy does not bind?",
    matters:
      "Every container-based harness loses this row, and saying so is the point: a benchmark whose author passes everything is an advertisement. Landlock binds a process and the children it forks — a process injected from outside is not a descendant of the restricted workload, so no in-sandbox policy applies to it.",
    berthNote:
      "Berth fails this row by construction and says so in docs/threat-model.md: root on the host reaches everything through `docker exec`, so for that channel the capability model is policy and audit, not a boundary. It is not a bug with a fix pending — it is the boundary's edge, and anyone evaluating Berth should know where that edge is.",
  },
  {
    id: "secret-in-metadata",
    kind: "observation",
    title: "Secret visible in runtime metadata",
    question: "Is a secret handed to the sandbox readable from the host's container metadata?",
    matters:
      "Anyone with read access to the daemon — a CI log, a monitoring agent, another developer on a shared box — can read environment variables out of container metadata without ever entering the sandbox.",
  },
  {
    id: "published-port-exposure",
    kind: "observation",
    title: "Ports published beyond loopback (incl. CDP 9222)",
    question: "Does the sandbox publish any port to a non-loopback address, or an unauthenticated debug port such as Chrome DevTools?",
    matters:
      "A debug port bound to 0.0.0.0 is remote code execution for anyone on the network. CDP in particular grants full browser control with no authentication.",
    berthNote:
      "Berth passes this as measured — 9222 is never mapped and terminal ports bind 127.0.0.1 with a credential — but REMEDIATION 1.7 names the residual this row cannot see: CDP stays reachable from inside the container and from any host-local process.",
  },
];

export const CHECK_BY_ID = Object.fromEntries(CHECKS.map((c) => [c.id, c]));
export const PROBE_CHECK_IDS = CHECKS.filter((c) => c.kind === "probe").map((c) => c.id);
