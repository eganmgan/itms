#!/usr/bin/env python3

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


READ_LIMITS = """map $request_method $itms_api_read_key {
    default "";
    GET $binary_remote_addr;
    HEAD $binary_remote_addr;
}
map $request_method $itms_api_write_key {
    default $binary_remote_addr;
    GET "";
    HEAD "";
}
limit_req_zone $itms_api_read_key zone=itms_api_reads:10m rate=10r/s;
"""
READ_RULE = "limit_req zone=itms_api_reads burst=60 nodelay;"
WRITE_ZONES = {"auth_limit": "itms_auth_writes", "api_limit": "itms_api_writes"}


def render_config(content):
    if any(marker in content for marker in ("itms_api_read_key", "itms_api_write_key", "itms_api_reads", *WRITE_ZONES.values())):
        raise ValueError("Repair markers already exist; inspect the configuration before reapplying.")
    updated = content
    for zone in ("auth_limit", "api_limit"):
        pattern = re.compile(
            r"^(?P<prefix>[ \t]*limit_req_zone[ \t]+)\$binary_remote_addr"
            r"(?P<suffix>[ \t]+zone=" + zone + r":[^;\n]+;[^\n]*)$",
            re.MULTILINE,
        )
        updated, count = pattern.subn(
            lambda match: match["prefix"] + "$itms_api_write_key" + match["suffix"].replace("zone=" + zone + ":", "zone=" + WRITE_ZONES[zone] + ":", 1),
            updated,
        )
        if count != 1:
            raise ValueError("Expected exactly one IP-based zone definition for " + zone)

    pattern = re.compile(
        r"^(?P<indent>[ \t]*)(?P<rule>limit_req[ \t]+zone=(?:auth_limit|api_limit)[ \t;][^\n]*)$",
        re.MULTILINE,
    )
    updated, count = pattern.subn(
        lambda match: match.group(0) + "\n" + match["indent"] + READ_RULE,
        updated,
    )
    if count < 2:
        raise ValueError("Expected authentication and API limit rules; refusing an incomplete repair.")
    for zone, replacement in WRITE_ZONES.items():
        updated = re.sub(r"(\blimit_req[ \t]+zone=)" + zone + r"(?=[ \t;])", lambda match: match[1] + replacement, updated)
    return READ_LIMITS + "\n" + updated


def render_patch_timeout(content):
    content = re.sub(
        r"\n[ \t]*location = /api/patch/batch \{\s*proxy_read_timeout 660s;\s*\}\n",
        "", content,
    )
    if re.search(r"location\s+[^\n{]*\/api\/patch\/batch", content):
        raise ValueError("A Patch batch location already exists; inspect it before reapplying.")
    pattern = re.compile(r"^(?P<indent>[ \t]*)location[ \t]+/api/[ \t]*\{(?P<body>[^{}]*)\}", re.MULTILINE)
    matches = list(pattern.finditer(content))
    if not matches:
        raise ValueError("Expected a flat /api/ proxy location; refusing an unknown layout.")
    for match in matches:
        if not re.search(r"\bproxy_pass\s+https?://[^/;\s]+;", match["body"]):
            raise ValueError("Expected an HTTP proxy without a URI suffix; inspect this layout manually.")

    def replace(match):
        indent = match["indent"]
        body = match["body"].rstrip()
        proxy = re.search(r"\bproxy_pass\s+https?://[^/;\s]+;", body).group(0)
        return (
            indent + "location /api/ {" + body + "\n\n"
            + indent + "    location = /api/patch/batch {\n"
            + indent + "        " + proxy + "\n"
            + indent + "        proxy_read_timeout 660s;\n"
            + indent + "    }\n" + indent + "}"
        )

    return pattern.sub(replace, content)


def atomic_write(path, content):
    metadata = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix=".itms-nginx-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(stream.fileno(), metadata.st_mode & 0o7777)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description="Separate nginx API read limits without replacing site settings.")
    parser.add_argument("--config", default="/etc/nginx/sites-enabled/itms")
    parser.add_argument("--patch-timeout", action="store_true", help="Only extend Patch batch response timeout to 660 seconds; do not change rate limits")
    parser.add_argument("--apply", action="store_true", help="Back up, validate, and reload nginx; requires root")
    args = parser.parse_args()
    if args.apply and os.geteuid() != 0:
        parser.error("Run --apply with sudo on the ITMS server.")
    path = Path(args.config).resolve(strict=True)
    original = path.read_text()
    candidate = render_patch_timeout(original) if args.patch_timeout else render_config(original)
    if not args.apply:
        print(candidate, end="")
        return

    subprocess.run(["nginx", "-t"], check=True)
    descriptor, backup_name = tempfile.mkstemp(prefix="itms-nginx-before-", suffix=".conf", dir="/var/backups")
    os.close(descriptor)
    backup = Path(backup_name)
    shutil.copyfile(path, backup)
    print("Configuration backup:", backup, flush=True)
    atomic_write(path, candidate)
    try:
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
    except (OSError, subprocess.CalledProcessError):
        atomic_write(path, original)
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
        raise
    if args.patch_timeout:
        print("Patch batch timeout set to 660 seconds. Existing API timeouts and rate limits preserved.")
    else:
        print("API read limits applied. Existing login/write limits and proxy settings preserved.")


if __name__ == "__main__":
    main()