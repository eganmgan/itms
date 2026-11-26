#!/usr/bin/env bash
set -euo pipefail

site="${NGINX_SITE_CONFIG:-/etc/nginx/sites-available/itms}"
dry_run=0

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi
if [[ ! -f "$site" ]]; then
  echo "nginx site config not found: $site" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*location[[:space:]]*=[[:space:]]*/api/chat/presence[[:space:]]*\{' "$site"; then
  echo "Exact Mattermost presence route already exists in $site; refusing to overwrite it." >&2
  exit 1
fi
if [[ "$dry_run" -eq 0 && "$EUID" -ne 0 ]]; then
  echo "Run this script with sudo to update nginx." >&2
  exit 1
fi

tmp="$(mktemp "${site}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

python3 - "$site" "$tmp" <<'PY'
import re
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
text = source.read_text()
lines = text.splitlines(keepends=True)
api_index = next(
    (index for index, line in enumerate(lines) if re.match(r"^([ \t]*)location[ \t]+/api/[ \t]*\{", line)),
    None,
)
if api_index is None:
    raise SystemExit("Could not find the /api/ nginx location.")

api_indent = re.match(r"^([ \t]*)", lines[api_index]).group(1)
depth = 0
api_lines = []
for line in lines[api_index:]:
    depth += line.count("{") - line.count("}")
    api_lines.append(line)
    if depth == 0:
        break
else:
    raise SystemExit("The /api/ nginx location is not closed.")

proxy = re.search(r"(?m)^[ \t]*proxy_pass[ \t]+([^;]+);", "".join(api_lines))
if proxy is None:
    raise SystemExit("Could not find proxy_pass in the /api/ nginx location.")

newline = "\r\n" if "\r\n" in text else "\n"
indent = api_indent
child = indent + "    "
block = [
    f"{indent}location = /api/chat/presence {{{newline}",
    f"{child}proxy_pass {proxy.group(1)};{newline}",
    f"{child}proxy_http_version 1.1;{newline}",
    f"{child}proxy_set_header Host $host;{newline}",
    f"{child}proxy_set_header X-Real-IP $remote_addr;{newline}",
    f"{child}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;{newline}",
    f"{child}proxy_set_header X-Forwarded-Proto $scheme;{newline}",
    f"{newline}",
    f"{child}proxy_connect_timeout 5s;{newline}",
    f"{child}proxy_send_timeout 10s;{newline}",
    f"{child}proxy_read_timeout 10s;{newline}",
    f"{indent}}}{newline}",
    f"{newline}",
]
destination.write_text("".join(lines[:api_index] + block + lines[api_index:]))
PY

if [[ "$dry_run" -eq 1 ]]; then
  cat "$tmp"
  exit 0
fi

backup="${site}.pre-chat-presence-rate-limit-$(date +%Y%m%d%H%M%S)"
if [[ -e "$backup" ]]; then
  echo "Backup path already exists: $backup" >&2
  exit 1
fi
cp -p -- "$site" "$backup"
chmod --reference="$site" "$tmp"
chown --reference="$site" "$tmp"
mv -- "$tmp" "$site"

if ! nginx -t; then
  cp -p -- "$backup" "$site"
  echo "nginx validation failed; restored the original config." >&2
  exit 1
fi
if ! systemctl reload nginx; then
  cp -p -- "$backup" "$site"
  if ! nginx -t || ! systemctl reload nginx; then
    echo "Reload failed and rollback could not be validated; contact an administrator." >&2
    exit 1
  fi
  echo "nginx reload failed; restored the original config." >&2
  exit 1
fi

echo "Presence heartbeat now bypasses the shared IP write limiter; backup: $backup"
