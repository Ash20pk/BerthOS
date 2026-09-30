// Enforcement probe for the microVM spike. Static musl binary, run inside the
// guest (usually under agent-init, as the app uid). Prints one line per check:
//   name=<check> result=<value> errno=<name>
// It never decides pass/fail itself; the host test script does that.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)

static const char *ename(int e) {
    switch (e) {
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOSYS: return "ENOSYS";
    case ENETUNREACH: return "ENETUNREACH";
    case EHOSTUNREACH: return "EHOSTUNREACH";
    case ECONNREFUSED: return "ECONNREFUSED";
    case ETIMEDOUT: return "ETIMEDOUT";
    case EAFNOSUPPORT: return "EAFNOSUPPORT";
    case EROFS: return "EROFS";
    case ENOENT: return "ENOENT";
    case EINVAL: return "EINVAL";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    default: return "other";
    }
}

static void report(const char *name, long rc, int err) {
    if (rc >= 0)
        printf("name=%s result=%ld errno=0\n", name, rc);
    else
        printf("name=%s result=-1 errno=%s\n", name, ename(err));
}

static void landlock_abi(void) {
    errno = 0;
    long v = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    report("landlock_abi", v, errno);
}

static void try_write(const char *name, const char *path) {
    errno = 0;
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    int err = errno;
    if (fd >= 0) {
        (void)!write(fd, "x\n", 2);
        close(fd);
    }
    report(name, fd >= 0 ? 0 : -1, err);
}

static void try_connect(const char *name, const char *ip, int port) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) {
        report(name, -1, errno);
        return;
    }
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port)};
    inet_pton(AF_INET, ip, &a.sin_addr);
    errno = 0;
    int rc = connect(s, (struct sockaddr *)&a, sizeof a);
    report(name, rc, errno);
    close(s);
}

static void try_io_uring(void) {
    // struct io_uring_params is 120 bytes; zeroed is a valid request.
    unsigned char params[120];
    memset(params, 0, sizeof params);
    errno = 0;
    long fd = syscall(__NR_io_uring_setup, 4, params);
    report("io_uring_setup", fd, errno);
    if (fd >= 0) close((int)fd);
}

static void try_vsock(void) {
    errno = 0;
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    report("socket_af_vsock", s, errno);
    if (s >= 0) close(s);
}

static void try_udp(void) {
    errno = 0;
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    report("socket_udp", s, errno);
    if (s >= 0) close(s);
}

int main(int argc, char **argv) {
    const char *ws = argc > 1 ? argv[1] : "/workspace";
    char okpath[512];
    snprintf(okpath, sizeof okpath, "%s/probe-ok", ws);
    printf("name=uid result=%d errno=0\n", (int)getuid());
    landlock_abi();
    try_write("write_etc_x", "/etc/x");
    try_write("write_declared", okpath);
    try_connect("connect_1.1.1.1:443", "1.1.1.1", 443);
    try_io_uring();
    try_vsock();
    try_udp();
    return 0;
}
