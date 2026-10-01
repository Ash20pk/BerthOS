# Asks the kernel for a UDP socket through io_uring's IORING_OP_SOCKET instead
# of socket(2), and prints one JSON line saying how far it got. Run by the
# probe_io_uring_socket export: Node has no io_uring binding, and the base
# image already ships python3, whose ctypes and mmap are enough to drive a
# one-entry ring by hand. Layouts are from <linux/io_uring.h>, and the syscall
# numbers are the same on x86_64 and aarch64.
#
#   {"stage": "setup", "errno": N}      io_uring_setup(2) itself was refused
#   {"stage": "op", "errno": N}         the ring worked, the SOCKET op failed
#   {"stage": "created", "soType": N}   a socket came back without socket(2)
import ctypes
import json
import mmap
import os
import socket
import struct

SYS_IO_URING_SETUP = 425
SYS_IO_URING_ENTER = 426
IORING_OFF_SQ_RING = 0
IORING_OFF_CQ_RING = 0x8000000
IORING_OFF_SQES = 0x10000000
IORING_OP_SOCKET = 45
IORING_ENTER_GETEVENTS = 1

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def report(**fields):
    print(json.dumps(fields))


# struct io_uring_params: 10 u32s, then io_sqring_offsets and
# io_cqring_offsets (8 u32s and a u64 each).
params = ctypes.create_string_buffer(120)
ring = libc.syscall(SYS_IO_URING_SETUP, ctypes.c_uint(1), params)
if ring < 0:
    report(stage="setup", errno=ctypes.get_errno())
    raise SystemExit(0)

sq_entries, cq_entries = struct.unpack_from("<II", params, 0)
sq_head, sq_tail, sq_mask, _, _, _, sq_array = struct.unpack_from("<7I", params, 40)
cq_head, _, cq_mask, _, _, cq_cqes = struct.unpack_from("<6I", params, 80)

prot = mmap.PROT_READ | mmap.PROT_WRITE
sq = mmap.mmap(ring, sq_array + sq_entries * 4, mmap.MAP_SHARED, prot, offset=IORING_OFF_SQ_RING)
cq = mmap.mmap(ring, cq_cqes + cq_entries * 16, mmap.MAP_SHARED, prot, offset=IORING_OFF_CQ_RING)
sqes = mmap.mmap(ring, sq_entries * 64, mmap.MAP_SHARED, prot, offset=IORING_OFF_SQES)

# io_uring_prep_socket(): fd = domain, off = type, len = protocol.
sqe = bytearray(64)
struct.pack_into("<B", sqe, 0, IORING_OP_SOCKET)
struct.pack_into("<i", sqe, 4, socket.AF_INET)
struct.pack_into("<Q", sqe, 8, socket.SOCK_DGRAM)
sqes[0:64] = bytes(sqe)

tail = struct.unpack_from("<I", sq, sq_tail)[0]
mask = struct.unpack_from("<I", sq, sq_mask)[0]
struct.pack_into("<I", sq, sq_array + (tail & mask) * 4, 0)
struct.pack_into("<I", sq, sq_tail, tail + 1)

if libc.syscall(SYS_IO_URING_ENTER, ring, 1, 1, IORING_ENTER_GETEVENTS, None, 0) < 0:
    report(stage="enter", errno=ctypes.get_errno())
    raise SystemExit(0)

head = struct.unpack_from("<I", cq, cq_head)[0]
mask = struct.unpack_from("<I", cq, cq_mask)[0]
res = struct.unpack_from("<i", cq, cq_cqes + (head & mask) * 16 + 8)[0]
if res < 0:
    report(stage="op", errno=-res)
else:
    so_type = socket.socket(fileno=res).getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)
    report(stage="created", soType=so_type)
os.close(ring)
