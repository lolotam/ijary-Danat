#!/bin/sh
# Restricts the Docker-published web ports (80/tcp, 443/tcp, 443/udp) on the
# public interface to Cloudflare's published ranges, so Traefik can only be
# reached through Cloudflare. Client IPs taken from Cloudflare headers (rate
# limits, audit rows) are only trustworthy when nothing can bypass it. Other
# ports are out of its scope: SSH is left open on purpose, and any port
# published later needs its own check (see deploy/README.md pre-flight).
#
# Why not UFW: Traefik's ports are published by Docker, and Docker DNATs
# them in PREROUTING and forwards them through FORWARD. UFW's rules live in
# INPUT, so they never see this traffic. DOCKER-USER is the chain Docker
# reserves for exactly this and never flushes.
#
# Usage (root):  cloudflare-origin-firewall.sh apply | remove | status
#   IFACE        public interface to filter (default: eth0). Traffic that
#                does not arrive on it — loopback, Docker networks — is
#                untouched.
#
# `apply` is idempotent and is what the systemd timer re-runs daily to pick
# up range changes. It refuses to apply an allowlist it could not fetch
# whole, because an empty allowlist would drop every visitor. The last good
# lists are kept in $STATE_DIR, so a boot with no network or a Cloudflare
# outage still loads the filter instead of leaving the ports open.

set -eu

IFACE="${IFACE:-eth0}"
CHAIN="CF-ORIGIN"
STATE_DIR="/var/lib/cloudflare-origin-firewall"
MIN_V4_RANGES=10
MIN_V6_RANGES=5

# يجلب نطاقات Cloudflare لعائلة عناوين واحدة، أو يفشل إن بدت القائمة ناقصة.
# Prints Cloudflare's ranges for one family, one CIDR per line, or fails.
fetch_ranges() {
  family="$1"
  minimum="$2"
  ranges="$(curl -fsS --max-time 20 "https://www.cloudflare.com/ips-$family")"
  count="$(printf '%s\n' "$ranges" | grep -cE '^[0-9a-fA-F:.]+/[0-9]+$' || true)"
  total="$(printf '%s\n' "$ranges" | grep -c . || true)"
  if [ "$count" -lt "$minimum" ] || [ "$count" -ne "$total" ]; then
    echo "Cloudflare $family list looks wrong ($count valid of $total lines)." >&2
    return 1
  fi
  printf '%s\n' "$ranges"
}

# يعيد قائمة حديثة ويحفظها، أو يعود إلى آخر نسخة سليمة محفوظة.
# Prints a fresh list and caches it, or falls back to the last good cache.
ranges_for() {
  family="$1"
  minimum="$2"
  cache="$STATE_DIR/ips-$family"
  if fresh="$(fetch_ranges "$family" "$minimum")"; then
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$fresh" >"$cache.tmp"
    mv "$cache.tmp" "$cache"
    printf '%s\n' "$fresh"
  elif [ -s "$cache" ]; then
    echo "Using the cached Cloudflare $family list from $cache." >&2
    cat "$cache"
  else
    echo "Refusing: no valid Cloudflare $family list and no cached copy." >&2
    return 1
  fi
}

# يعيد بناء سلسلة السماح دون لحظة تبقى فيها المنافذ مفتوحة.
# Rebuilds the allowlist chain for one iptables binary with no unfiltered
# moment: the new chain is filled and hooked before the old one is unhooked,
# then renamed into place (a rename keeps the jumps that point at it).
apply_family() {
  tool="$1"
  ranges="$2"
  staging="${CHAIN}-NEW"

  unhook "$tool" "$staging"
  "$tool" -N "$staging" 2>/dev/null || "$tool" -F "$staging"
  printf '%s\n' "$ranges" | while read -r range; do
    "$tool" -A "$staging" -s "$range" -j RETURN
  done
  "$tool" -A "$staging" -j DROP

  hook "$tool" "$staging"
  unhook "$tool" "$CHAIN"
  if "$tool" -S "$CHAIN" >/dev/null 2>&1; then
    "$tool" -F "$CHAIN"
    "$tool" -X "$CHAIN"
  fi
  "$tool" -E "$staging" "$CHAIN"
}

# يوجّه اتصالات الويب الجديدة الواردة على الواجهة العامة إلى سلسلة.
# Sends new web connections arriving on the public interface to a chain.
hook() {
  tool="$1"
  target="$2"
  "$tool" -I DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports 80,443 \
    -m conntrack --ctstate NEW -j "$target"
  "$tool" -I DOCKER-USER -i "$IFACE" -p udp --dport 443 \
    -m conntrack --ctstate NEW -j "$target"
}

# يزيل كل قفزة من DOCKER-USER إلى السلسلة المسمّاة مهما تكرّرت.
# Removes every DOCKER-USER jump to the named chain, however many exist.
unhook() {
  tool="$1"
  target="$2"
  "$tool" -S DOCKER-USER 2>/dev/null | grep -- "-j $target\$" | sed 's/^-A /-D /' |
    while read -r rule; do
      # shellcheck disable=SC2086 # the rule is a list of iptables arguments
      "$tool" $rule
    done
}

# يتحقّق من وجود سلسلة DOCKER-USER التي أنشأها Docker لهذه الأداة.
# True when this iptables binary has Docker's DOCKER-USER chain to hook into.
has_docker_user() {
  "$1" -S DOCKER-USER >/dev/null 2>&1
}

# يطبّق المرشّح على IPv4 (وIPv6 إن فعّله Docker) بعد جلب القائمتين أولاً.
apply() {
  # A misspelt interface would match nothing and leave the ports open while
  # reporting success.
  ip link show "$IFACE" >/dev/null 2>&1 || {
    echo "Interface $IFACE does not exist; set IFACE to the public interface." >&2
    exit 1
  }
  has_docker_user iptables || {
    echo "DOCKER-USER is missing; start Docker first." >&2
    exit 1
  }
  # Both lists are resolved before any rule changes. Assignments, not inline
  # `$(...)` arguments: `set -e` ignores a failed substitution inside an
  # argument list, which would build a chain from an empty list.
  v4="$(ranges_for v4 "$MIN_V4_RANGES")"
  v6=""
  if has_docker_user ip6tables; then
    v6="$(ranges_for v6 "$MIN_V6_RANGES")"
  fi
  apply_family iptables "$v4"
  if [ -n "$v6" ]; then
    apply_family ip6tables "$v6"
  fi
  echo "Web ports on $IFACE now accept Cloudflare only."
}

# يزيل المرشّح كاملاً، بما فيه سلسلة التجهيز إن توقّف apply في منتصفه.
# Also clears the staging chain: an apply interrupted after hooking it would
# otherwise leave its DROP in place, and the escape hatch would not restore
# access.
remove() {
  for tool in iptables ip6tables; do
    has_docker_user "$tool" || continue
    for chain in "$CHAIN" "${CHAIN}-NEW"; do
      unhook "$tool" "$chain"
      "$tool" -F "$chain" 2>/dev/null && "$tool" -X "$chain" || true
    done
  done
  echo "Cloudflare origin filter removed; web ports are open to everyone."
}

# يعرض القفزات في DOCKER-USER وعدد النطاقات المسموح بها.
status() {
  for tool in iptables ip6tables; do
    has_docker_user "$tool" || continue
    echo "== $tool DOCKER-USER"
    "$tool" -S DOCKER-USER
    "$tool" -S "$CHAIN" 2>/dev/null | grep -c -- '-j RETURN' |
      sed "s/^/$CHAIN allowlisted ranges: /" || echo "$CHAIN not installed"
  done
}

case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  status) status ;;
  *)
    echo "usage: $0 apply|remove|status" >&2
    exit 2
    ;;
esac
