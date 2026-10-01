//! Per-app cgroups (cgroup v2), the same tree as feat/per-app-cgroups'
//! entrypoint.sh, rooted at the guest's own cgroup root:
//!
//!   /sys/fs/cgroup
//!   └── berth/
//!       ├── daemons/     berth-init itself (the relay), context-bus-daemon,
//!       │                the policy compiler runs; cpu.weight 1000
//!       └── apps/        memory.max = guest memory less the daemon reserve
//!           └── <app>/   cpu.max, cpu.weight, memory.max, memory.swap.max, pids.max
//!
//! In a container this needs a delegated, nsdelegate-mounted namespace. In
//! the VM berth-init owns the whole hierarchy, so none of that applies; the
//! guest kernel is the bound, and the VM's own vCPU/RAM caps are the outer one.
//!
//! Everything takes the cgroup root as a path so the unit tests can run it
//! against a directory that imitates the kernel's files.

use crate::plan;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Cgroups {
    pub root: PathBuf,
}

#[derive(Debug, Default, PartialEq)]
pub struct Setup {
    /// Controllers enabled for the apps' cgroups.
    pub controllers: Vec<String>,
    /// apps/memory.max as written, None when no reserve could be kept.
    pub apps_memory_max: Option<u64>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Applied {
    pub dir: PathBuf,
    /// Read back from the kernel after writing, not taken from the policy.
    pub limits: Vec<(String, String)>,
    pub skipped: Vec<String>,
    /// Limits that should have applied and did not: fatal under strict mode.
    pub failed: Vec<String>,
}

/// Write a cgroup interface file. Never creates one: on cgroupfs a missing
/// file means the controller is not enabled, and creating a regular file in
/// its place (as O_CREAT would on the test directory) would hide that.
pub fn write_file(path: &Path, value: &str) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).open(path)?;
    // One write(2): the kernel parses each write as one value.
    f.write_all(format!("{value}\n").as_bytes())
}

fn read_trim(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

impl Cgroups {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Cgroups { root: root.into() }
    }
    pub fn berth(&self) -> PathBuf {
        self.root.join("berth")
    }
    pub fn daemons(&self) -> PathBuf {
        self.root.join("berth/daemons")
    }
    pub fn apps(&self) -> PathBuf {
        self.root.join("berth/apps")
    }
    pub fn app(&self, name: &str) -> PathBuf {
        self.apps().join(name)
    }

    /// Enables cpu, memory and pids in `dir`'s subtree_control, one at a time
    /// so a missing one costs only itself. Returns what is now enabled.
    pub fn enable_controllers(&self, dir: &Path) -> Vec<String> {
        let available = read_trim(&dir.join("cgroup.controllers")).unwrap_or_default();
        let mut enabled = Vec::new();
        for c in ["cpu", "memory", "pids"] {
            if !available.split_whitespace().any(|a| a == c) {
                continue;
            }
            let already = read_trim(&dir.join("cgroup.subtree_control")).unwrap_or_default();
            if already.split_whitespace().any(|a| a == c) || write_file(&dir.join("cgroup.subtree_control"), &format!("+{c}")).is_ok() {
                enabled.push(c.to_string());
            }
        }
        enabled
    }

    /// Builds berth/{daemons,apps}, moves `self_pid` (berth-init) into
    /// daemons, enables the controllers, and sets the daemon reserve.
    /// `mem_total` is the guest's MemTotal in bytes.
    pub fn setup(&self, self_pid: u32, mem_total: Option<u64>, reserve_mb: u64) -> Result<Setup, String> {
        if !self.root.join("cgroup.controllers").is_file() {
            return Err(format!("{} is not a cgroup v2 hierarchy", self.root.display()));
        }
        for d in [self.daemons(), self.apps()] {
            fs::create_dir_all(&d).map_err(|e| format!("could not create {}: {e}", d.display()))?;
        }
        // The root cgroup is exempt from the no-internal-processes rule, so
        // berth-init could stay there; it moves so that the relay threads it
        // runs are counted in, and protected by, the daemons' share.
        write_file(&self.daemons().join("cgroup.procs"), &self_pid.to_string())
            .map_err(|e| format!("could not move berth-init into {}: {e}", self.daemons().display()))?;
        let top = self.enable_controllers(&self.root);
        if top.is_empty() {
            return Err(format!("no controller could be enabled in {}", self.root.display()));
        }
        self.enable_controllers(&self.berth());
        let controllers = self.enable_controllers(&self.apps());

        let _ = write_file(&self.daemons().join("cpu.weight"), plan::DAEMON_CPU_WEIGHT);
        let mut apps_memory_max = None;
        if let Some(total) = mem_total {
            if let Some(max) = plan::apps_memory_max(total, reserve_mb) {
                if write_file(&self.apps().join("memory.max"), &max.to_string()).is_ok() {
                    apps_memory_max = Some(max);
                }
            }
        }
        Ok(Setup { controllers, apps_memory_max })
    }

    /// Creates apps/<name> and writes its limits. Does not move anything into
    /// it: the app's process joins it itself, between fork and exec (see
    /// main.rs), so nothing it starts is ever outside it.
    pub fn apply_app(&self, name: &str, limits: &[(String, String)], skipped: Vec<String>, swap_total: Option<u64>) -> Applied {
        let dir = self.app(name);
        let mut out = Applied { dir: dir.clone(), skipped, ..Default::default() };
        if let Err(e) = fs::create_dir_all(&dir) {
            out.failed.push(format!("could not create {}: {e}", dir.display()));
            return out;
        }
        for (file, value) in limits {
            let path = dir.join(file);
            if !path.exists() {
                out.skipped.push(format!("{file} (no such file — controller not enabled)"));
                // The one absence strict mode lets through: no swap accounting
                // on a machine with no swap leaves nothing to limit.
                if !(file == "memory.swap.max" && swap_total == Some(0)) {
                    out.failed.push(format!("{file} (no such file)"));
                }
                continue;
            }
            if let Err(e) = write_file(&path, value) {
                out.skipped.push(format!("{file}={value} (write refused: {e})"));
                out.failed.push(format!("{file}={value} (write refused)"));
            }
        }
        for file in plan::LIMIT_FILES {
            if let Some(v) = read_trim(&dir.join(file)) {
                out.limits.push((file.to_string(), v));
            }
        }
        out
    }

    /// The pids in a cgroup, for status reports.
    pub fn procs(&self, dir: &Path) -> Vec<u32> {
        read_trim(&dir.join("cgroup.procs"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect()
    }

    pub fn read_limits(&self, dir: &Path) -> Vec<(String, String)> {
        plan::LIMIT_FILES
            .iter()
            .filter_map(|f| read_trim(&dir.join(f)).map(|v| (f.to_string(), v)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    /// A directory laid out like a cgroup2 mount: the files the kernel would
    /// create for each cgroup are created up front by the test.
    fn fake_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("berth-init-cg-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn kernel_files(dir: &Path, files: &[&str], controllers: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("cgroup.controllers"), controllers).unwrap();
        fs::write(dir.join("cgroup.subtree_control"), "").unwrap();
        fs::write(dir.join("cgroup.procs"), "").unwrap();
        for f in files {
            fs::write(dir.join(f), "max\n").unwrap();
        }
    }

    #[test]
    fn setup_builds_the_tree_and_reserve() {
        let root = fake_root();
        let cg = Cgroups::new(&root);
        kernel_files(&root, &[], "cpuset cpu io memory pids");
        kernel_files(&cg.berth(), &[], "cpu memory pids");
        kernel_files(&cg.daemons(), &["cpu.weight"], "");
        kernel_files(&cg.apps(), &["memory.max"], "cpu memory pids");
        let s = cg.setup(1, Some(1024 * 1024 * 1024), 256).unwrap();
        assert_eq!(s.controllers, vec!["cpu", "memory", "pids"]);
        assert_eq!(s.apps_memory_max, Some(768 * 1024 * 1024));
        assert_eq!(fs::read_to_string(cg.daemons().join("cgroup.procs")).unwrap(), "1\n");
        assert_eq!(fs::read_to_string(cg.daemons().join("cpu.weight")).unwrap(), "1000\n");
        assert_eq!(fs::read_to_string(cg.apps().join("memory.max")).unwrap(), "805306368\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn setup_refuses_without_cgroup2() {
        let root = fake_root();
        assert!(Cgroups::new(&root).setup(1, None, 256).unwrap_err().contains("not a cgroup v2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn small_guest_keeps_no_reserve() {
        let root = fake_root();
        let cg = Cgroups::new(&root);
        kernel_files(&root, &[], "cpu memory pids");
        kernel_files(&cg.berth(), &[], "cpu memory pids");
        kernel_files(&cg.daemons(), &["cpu.weight"], "");
        kernel_files(&cg.apps(), &["memory.max"], "cpu memory pids");
        let s = cg.setup(1, Some(200 * 1024 * 1024), 256).unwrap();
        assert_eq!(s.apps_memory_max, None);
        assert_eq!(fs::read_to_string(cg.apps().join("memory.max")).unwrap(), "max\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_writes_limits_and_reads_them_back() {
        let root = fake_root();
        let cg = Cgroups::new(&root);
        kernel_files(&cg.app("notes"), &["cpu.max", "cpu.weight", "memory.max", "pids.max"], "");
        let limits = vec![
            ("cpu.max".to_string(), "50000 100000".to_string()),
            ("cpu.weight".to_string(), "100".to_string()),
            ("memory.max".to_string(), "134217728".to_string()),
            ("memory.swap.max".to_string(), "0".to_string()),
            ("pids.max".to_string(), "128".to_string()),
        ];
        // No swap in the guest: a missing memory.swap.max is skipped, not failed.
        let a = cg.apply_app("notes", &limits, vec![], Some(0));
        assert!(a.failed.is_empty(), "{:?}", a.failed);
        assert_eq!(a.skipped.len(), 1);
        assert_eq!(
            a.limits,
            vec![
                ("cpu.max".to_string(), "50000 100000".to_string()),
                ("cpu.weight".to_string(), "100".to_string()),
                ("memory.max".to_string(), "134217728".to_string()),
                ("pids.max".to_string(), "128".to_string()),
            ]
        );
        // Nothing outside the limit files was created.
        assert!(!cg.app("notes").join("memory.swap.max").exists());
        // With swap present, the same absence is a failure.
        let a = cg.apply_app("notes", &limits, vec![], Some(1 << 30));
        assert_eq!(a.failed, vec!["memory.swap.max (no such file)".to_string()]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_controller_is_a_failure() {
        let root = fake_root();
        let cg = Cgroups::new(&root);
        kernel_files(&cg.app("a"), &["pids.max"], "");
        let a = cg.apply_app("a", &[("cpu.max".into(), "1000 100000".into()), ("pids.max".into(), "64".into())], vec![], Some(0));
        assert_eq!(a.failed, vec!["cpu.max (no such file)".to_string()]);
        assert_eq!(a.limits, vec![("pids.max".to_string(), "64".to_string())]);
        fs::remove_dir_all(root).unwrap();
    }
}
