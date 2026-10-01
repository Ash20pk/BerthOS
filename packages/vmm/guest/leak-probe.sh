#!/bin/sh
# Stretch-goal probe: mount a virtio-fs share called "leak" and try to read it.
# Run with the share pointing OUTSIDE what the host Seatbelt profile allows,
# to show that the VMM's host confinement bounds what the guest can reach.
mkdir -p /tmp/leak
mount -t tmpfs tmpfs /tmp 2>/dev/null; mkdir -p /tmp/leak
if mount -t virtiofs -o ro leak /tmp/leak 2>/tmp/err; then
    echo "leak: mounted"
    if ls /tmp/leak >/tmp/ls 2>&1; then echo "leak: listed $(wc -l </tmp/ls) entries: $(head -3 /tmp/ls | tr '\n' ' ')"; else echo "leak: ls failed: $(cat /tmp/ls)"; fi
    f=$(ls /tmp/leak 2>/dev/null | head -1)
    [ -n "$f" ] && { head -c 60 "/tmp/leak/$f" >/dev/null 2>/tmp/err && echo "leak: read $f OK" || echo "leak: read $f failed: $(cat /tmp/err)"; }
else
    echo "leak: mount failed: $(cat /tmp/err)"
fi
echo "app share parent: $(ls /app/.. 2>&1 | head -5 | tr '\n' ' ')"
