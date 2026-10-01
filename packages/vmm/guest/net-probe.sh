#!/bin/sh
# Goal 1 probe: what network does the guest have?
echo "--- links"; ip -o link
echo "--- addrs"; ip -o addr
echo "--- routes"; ip route; echo "(end routes)"
for i in /sys/class/net/*; do echo "$(basename $i) operstate=$(cat $i/operstate) flags=$(cat $i/flags)"; done
echo "--- connect 1.1.1.1:443"
timeout 5 nc -w 3 1.1.1.1 443 </dev/null; echo "nc rc=$?"
echo "--- http://1.1.1.1/"
timeout 6 wget -q -T 4 -O /dev/null http://1.1.1.1/; echo "wget rc=$?"
