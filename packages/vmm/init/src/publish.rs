// Guest TCP ports published to the host (berth-vmm run --publish): for each
// port in BERTH_VM_PUBLISH, berth-init listens on vsock PUBLISH_PORT_BASE + i,
// which berth-vmm maps to <run-dir>/publish-<port>.sock, and relays every
// connection to 127.0.0.1:<port> inside the guest. That is how a human
// reaches apps/terminal's ttyd from the host, as Docker's loopback port
// mapping does for a container.
//
// The guest has no network device, so 127.0.0.1 is the only address a
// published port can mean, and the app behind it (ttyd) does its own
// authentication; this is a pipe, not a policy. berth-init relays as root
// but only ever connects to loopback ports berth-vmm was told to publish.
use crate::{hub, plan, sys};
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Connections relayed at once, per published port.
const MAX_CONNS: usize = 32;

pub fn serve(ports: &[u16]) {
    for (i, port) in ports.iter().copied().enumerate() {
        let vport = plan::PUBLISH_PORT_BASE + i as u32;
        let listener = match sys::vsock_listen(vport) {
            Ok(l) => l,
            Err(e) => {
                hub::info(&format!("WARNING: cannot listen on vsock:{vport} to publish port {port}: {e}"));
                continue;
            }
        };
        hub::event("port_published", serde_json::json!({ "port": port, "vsockPort": vport }));
        let active = Arc::new(AtomicUsize::new(0));
        let _ = std::thread::Builder::new().name(format!("publish-{port}")).spawn(move || loop {
            let Ok(conn) = sys::accept(listener.as_raw_fd()) else { continue };
            if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
                active.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let active = active.clone();
            std::thread::spawn(move || {
                // Nothing listening yet (ttyd starts with the first terminal
                // call) closes the host's connection; its client retries.
                if let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)) {
                    relay(File::from(conn), tcp);
                }
                active.fetch_sub(1, Ordering::SeqCst);
            });
        });
    }
}

/// Copies both ways until either side closes, then closes both.
fn relay(vsock: File, tcp: TcpStream) {
    let (Ok(mut v_read), Ok(mut t_read)) = (vsock.try_clone(), tcp.try_clone()) else { return };
    let (mut v_write, mut t_write) = (vsock, tcp);
    let up = std::thread::spawn(move || {
        let _ = pump(&mut v_read, &mut t_write);
        let _ = t_write.shutdown(Shutdown::Write);
    });
    let _ = pump(&mut t_read, &mut v_write);
    let _ = t_read.shutdown(Shutdown::Both);
    drop(v_write);
    let _ = up.join();
}

fn pump(from: &mut impl Read, to: &mut impl Write) -> std::io::Result<()> {
    let mut buf = [0u8; 16384];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        to.write_all(&buf[..n])?;
    }
}
