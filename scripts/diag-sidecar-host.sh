#!/bin/bash
# Run ON a sidecar host to diagnose a WS tunnel that carries the register
# frame and nothing else. Read-only; prints a report. MASTER is the master's
# overlay IP as the sidecar sees it. Usage:
#   ssh <sidecar-host> 'MASTER=<master-ip> bash -s' < scripts/diag-sidecar-host.sh
MASTER=${MASTER:?set MASTER to the master overlay IP}
echo "## host: $(hostname)  $(date -u +%FT%TZ)  uptime: $(uptime -p 2>/dev/null)"
echo "## clock vs pool.ntp.org"; (command -v chronyc >/dev/null && chronyc tracking 2>/dev/null | head -4) || (timedatectl 2>/dev/null | grep -iE "synchronized|NTP service|Time zone")
echo; echo "## netbird status (this side)"; (command -v netbird >/dev/null && netbird status -d 2>/dev/null | grep -A6 "$MASTER" ) || echo "netbird CLI not found (container? try: docker exec netbird netbird status -d)"
echo; echo "## interfaces + MTU"; ip -brief link 2>/dev/null | grep -iE "wt|netbird|tun|wg|docker|br-" ; ip -brief addr 2>/dev/null | grep -E "100\.114|10\.10\.20"
echo; echo "## routes to master"; ip route get "$MASTER" 2>/dev/null
echo; echo "## small vs large HTTP POST to the master over the overlay"
curl -s -o /dev/null -m 10 -w "small  : HTTP %{http_code} in %{time_total}s\n" -X POST "http://$MASTER:3848/health" -d '{}' || echo "small  : FAILED"
head -c 51200 /dev/zero | tr '\0' 'x' > /tmp/big.txt
curl -s -o /dev/null -m 20 -w "50KB   : HTTP %{http_code} in %{time_total}s\n" -X POST "http://$MASTER:3848/health" --data-binary @/tmp/big.txt || echo "50KB   : FAILED"
echo; echo "## TCP sockets to the master (retransmits / unacked = outbound dying)"
(ss -tin dst "$MASTER" 2>/dev/null || netstat -tn 2>/dev/null | grep "$MASTER") | head -20
echo; echo "## sidecar container network mode + published ports"
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep -iE "sidecar|agent|ss-" ; docker inspect -f '{{.Name}} net={{.HostConfig.NetworkMode}}' $(docker ps -q 2>/dev/null) 2>/dev/null | grep -iE "sidecar|agent"
echo; echo "## sidecar log: reconnect reasons (last 40 relevant lines)"
C=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE "sidecar|agent" | head -1)
[ -n "$C" ] && docker logs --since 30m "$C" 2>&1 | grep -E "3848|3003" | grep -iE "heartbeat failed|forcing reconnect|timed out|acknowledged|connectMaster|Falling back|closed|ECONN|EPIPE" | tail -40
