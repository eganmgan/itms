#!/usr/bin/env python3

import argparse
import configparser
import datetime
import getpass
import json
import os
import platform
import plistlib
import re
import shutil
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path


AGENT_ENV_FILE = Path(os.getenv("ITMS_AGENT_ENV_FILE", "/etc/itms-agent.env"))

def is_macos():
    return platform.system() == "Darwin"


def run_command(command, timeout=15):
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if result.returncode != 0 and not result.stdout:
        return ""
    return result.stdout.strip()


def read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="ignore").strip()
    except OSError:
        return ""


def read_value_file(path):
    try:
        return Path(path).expanduser().read_text(encoding="utf-8", errors="ignore").rstrip("\r\n")
    except OSError:
        return ""


def read_secret_prompt(label):
    if sys.stdin.isatty() or sys.stderr.isatty():
        return getpass.getpass(f"{label}: ").strip()

    value = sys.stdin.readline()
    if not value:
        return ""
    return value.rstrip("\r\n")


def env_file_value(name):
    if not AGENT_ENV_FILE.is_file():
        return ""

    prefix = f"{name}="
    try:
        for line in AGENT_ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith(prefix):
                return line[len(prefix):].strip()
    except OSError:
        return ""
    return ""


def env_flag(name):
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def env_list(name):
    raw = os.getenv(name, "").strip()
    if not raw:
        return []
    values = []
    for part in raw.replace(";", ",").split(","):
        value = part.strip()
        if value:
            values.append(value)
    return values


def command_exists(name):
    return shutil.which(name) is not None


def parse_summary_count(value):
    if not value:
        return 0
    first_token = value.split()[0].strip()
    return int(first_token) if first_token.isdigit() else 0


def parse_os_release():
    values = {}
    for line in read_text("/etc/os-release").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"')
    return values


def format_bytes(size_bytes):
    if size_bytes <= 0:
        return "Unknown"
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    value = float(size_bytes)
    unit_index = 0
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1
    if value >= 100 or unit_index == 0:
        return f"{int(round(value))} {units[unit_index]}"
    return f"{value:.1f} {units[unit_index]}"


def truncate_text(value, limit=20000):
    value = (value or "").strip()
    if len(value) <= limit:
        return value
    return value[: limit - 16].rstrip() + "\n... output truncated"


def collect_processor():
    for line in read_text("/proc/cpuinfo").splitlines():
        if line.lower().startswith("model name"):
            return line.split(":", 1)[1].strip()
    output = run_command(["lscpu"])
    for line in output.splitlines():
        if line.lower().startswith("model name:"):
            return line.split(":", 1)[1].strip()
    if is_macos():
        return run_command(["sysctl", "-n", "machdep.cpu.brand_string"]) or run_command(["sysctl", "-n", "hw.model"]) or "Unknown CPU"
    return platform.processor() or "Unknown CPU"


def collect_memory():
    for line in read_text("/proc/meminfo").splitlines():
        if line.startswith("MemTotal:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return format_bytes(int(parts[1]) * 1024)
    if is_macos():
        size = run_command(["sysctl", "-n", "hw.memsize"])
        if size.isdigit():
            return format_bytes(int(size))
    return "Unknown RAM"


def collect_storage():
    output = run_command(["lsblk", "-b", "-dn", "-o", "SIZE,TYPE"])
    total = 0
    for line in output.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        size, device_type = parts
        if device_type != "disk" or not size.isdigit():
            continue
        total += int(size)
    if total == 0:
        if is_macos():
            try:
                return format_bytes(shutil.disk_usage("/").total)
            except OSError:
                pass
        return "Unknown storage"
    return format_bytes(total)


def flatten_block_devices(devices, parent=""):
    flattened = []
    for device in devices or []:
        current = dict(device)
        current["parent_name"] = parent
        flattened.append(current)
        flattened.extend(flatten_block_devices(device.get("children") or [], device.get("name", "")))
    return flattened


def collect_volume_details():
    if is_macos():
        output = run_command(["/usr/sbin/diskutil", "info", "-plist", "/"], timeout=20)
        try:
            info = plistlib.loads(output.encode("utf-8"))
        except (ValueError, plistlib.InvalidFileException):
            return []
        return [{"name": str(info.get("VolumeName", "")), "path": str(info.get("DeviceNode", "")),
                 "size": format_bytes(int(info.get("TotalSize", 0))), "filesystem": str(info.get("FilesystemType", "")),
                 "device_type": "volume", "mountpoint": "/", "available": format_bytes(int(info.get("VolumeFreeSpace", 0))),
                 "uuid": str(info.get("VolumeUUID", "")), "encrypted": bool(info.get("FileVault", False)),
                 "encryption": "FileVault" if info.get("FileVault") else ""}]
    output = run_command([
        "lsblk",
        "-J",
        "-b",
        "-o",
        "NAME,PATH,SIZE,FSTYPE,TYPE,MOUNTPOINT,FSAVAIL,FSUSE%,UUID,PKNAME",
    ], timeout=20)
    if not output:
        return []

    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return []

    volumes = []
    for item in flatten_block_devices(parsed.get("blockdevices") or []):
        device_type = (item.get("type") or "").strip().lower()
        if device_type in {"loop", "rom"}:
            continue
        name = (item.get("name") or "").strip()
        path = (item.get("path") or "").strip()
        fstype = (item.get("fstype") or "").strip()
        mountpoint = (item.get("mountpoint") or "").strip()
        encrypted = fstype.lower() == "crypto_luks" or path.startswith("/dev/mapper/") or name.startswith("dm-")
        encryption = "LUKS" if fstype.lower() == "crypto_luks" else ("device-mapper" if encrypted else "")
        size_raw = item.get("size")
        available_raw = item.get("fsavail")

        volumes.append({
            "name": name,
            "path": path,
            "size": format_bytes(int(size_raw)) if str(size_raw).isdigit() else str(size_raw or ""),
            "filesystem": fstype,
            "device_type": device_type,
            "mountpoint": mountpoint,
            "available": format_bytes(int(available_raw)) if str(available_raw).isdigit() else str(available_raw or ""),
            "used_percent": str(item.get("fsuse%") or ""),
            "uuid": (item.get("uuid") or "").strip(),
            "parent": (item.get("pkname") or item.get("parent_name") or "").strip(),
            "encrypted": encrypted,
            "encryption": encryption,
        })
    return volumes


def collect_disk_layout():
    if is_macos():
        return truncate_text(run_command(["/usr/sbin/diskutil", "list"], timeout=20))
    return truncate_text(run_command(["fdisk", "-l"], timeout=20))


def collect_remote_access_id(command, args=None):
    executable = shutil.which(command)
    if not executable and is_macos():
        candidates = {"anydesk": ["/Applications/AnyDesk.app/Contents/MacOS/AnyDesk"],
                      "rustdesk": ["/Applications/RustDesk.app/Contents/MacOS/RustDesk", "/Applications/RustDesk.app/Contents/MacOS/rustdesk"]}
        executable = next((p for p in candidates.get(command, []) if Path(p).is_file()), None)
    if not executable:
        return ""
    output = run_command([executable, *(args or ["--get-id"])], timeout=10)
    value = output.splitlines()[0].strip() if output else ""
    return re.sub(r"[ -]", "", value) if re.fullmatch(r"\d[\d -]{4,30}", value) else ""


def collect_gpu():
    if is_macos():
        for line in run_command(["system_profiler", "SPDisplaysDataType"]).splitlines():
            if "Chipset Model:" in line:
                return line.split(":", 1)[1].strip()
        return ""
    if not command_exists("lspci"):
        return ""
    devices = []
    for line in run_command(["lspci"]).splitlines():
        normalized = line.lower()
        if "vga compatible controller" not in normalized and "3d controller" not in normalized and "display controller" not in normalized:
            continue
        label = line.split(": ", 1)[1].strip() if ": " in line else line.strip()
        if label and label not in devices:
            devices.append(label)
    return "; ".join(devices)


@lru_cache(maxsize=1)
def collect_hardinfo_report():
    if not command_exists("hardinfo"):
        return ""
    return run_command(["hardinfo", "-r"], timeout=30)


def collect_display(use_hardinfo_fallback=False):
    if is_macos():
        displays = []
        for line in run_command(["system_profiler", "SPDisplaysDataType"]).splitlines():
            if "Resolution:" in line:
                displays.append(line.split(":", 1)[1].strip())
        return "; ".join(displays)

    display_name = os.getenv("DISPLAY", "").strip()
    if display_name and command_exists("xrandr"):
        connected = []
        for line in run_command(["xrandr", "--current"]).splitlines():
            if " connected" not in line:
                continue
            parts = line.split()
            if not parts:
                continue
            output_name = parts[0]
            resolution = ""
            for part in parts[1:]:
                if "x" in part and "+" in part:
                    resolution = part.split("+", 1)[0]
                    break
            connected.append(f"{output_name} {resolution}".strip())
        if connected:
            return "; ".join(connected)

    if not use_hardinfo_fallback:
        return ""

    resolution = ""
    renderer = ""
    for line in collect_hardinfo_report().splitlines():
        stripped = line.strip()
        if stripped.startswith("Resolution") and ":" in stripped:
            resolution = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("OpenGL Renderer") and ":" in stripped:
            renderer = stripped.split(":", 1)[1].strip()
    details = []
    if resolution and resolution != "0x0 pixels":
        details.append(resolution)
    if renderer and renderer != "(Unknown)":
        details.append(renderer)
    return "; ".join(details)


def collect_primary_mac_address():
    if is_macos():
        interface = run_command(["route", "get", "default"])
        match = re.search(r"interface:\s+(\S+)", interface)
        if match:
            output = run_command(["ifconfig", match.group(1)])
            address = re.search(r"ether\s+([0-9a-f:]{17})", output, re.IGNORECASE)
            if address:
                return address.group(1).lower()
    if not command_exists("ip"):
        return ""
    primary = ""
    fallback = ""
    virtual_prefixes = ("docker", "br-", "veth", "virbr", "lo", "tun", "tap", "wg")
    for line in run_command(["ip", "-o", "link", "show"]).splitlines():
        if "link/ether" not in line:
            continue
        parts = line.split(": ", 2)
        if len(parts) < 2:
            continue
        interface_name = parts[1].split("@", 1)[0].strip()
        mac_address = line.split("link/ether", 1)[1].strip().split()[0].lower()
        if not fallback:
            fallback = mac_address
        if interface_name.startswith(virtual_prefixes):
            continue
        primary = mac_address
        break
    return primary or fallback


def collect_last_boot():
    if is_macos():
        boot_time = run_command(["sysctl", "-n", "kern.boottime"])
        match = re.search(r"sec\s*=\s*(\d+)", boot_time)
        if match:
            return datetime.datetime.fromtimestamp(int(match.group(1)), datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    value = run_command(["bash", "-lc", "date -u -d \"$(uptime -s)\" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null"])
    if value:
        return value

    boot_line = run_command(["who", "-b"])
    if not boot_line:
        return ""
    text = boot_line.split("system boot", 1)[-1].strip()
    if not text:
        return ""
    for fmt in ("%Y-%m-%d %H:%M", "%b %d %H:%M"):
        try:
            parsed = datetime.datetime.strptime(text, fmt)
        except ValueError:
            continue
        if fmt == "%b %d %H:%M":
            parsed = parsed.replace(year=datetime.datetime.utcnow().year)
        return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")
    return ""


def collect_serial_number():
    if is_macos():
        match = re.search(r"Serial Number \(system\):\s*(\S+)", macos_hardware_profile())
        return match.group(1) if match else ""
    return read_text("/sys/class/dmi/id/product_serial") or read_text("/sys/devices/virtual/dmi/id/product_serial") or ""


def collect_manufacturer():
    return "Apple Inc." if is_macos() else read_text("/sys/class/dmi/id/sys_vendor") or ""


def collect_model():
    if is_macos():
        match = re.search(r"Model (?:Name|Identifier):\s*(.+)", macos_hardware_profile())
        return match.group(1).strip() if match else ""
    return read_text("/sys/class/dmi/id/product_name") or ""


@lru_cache(maxsize=1)
def macos_hardware_profile():
    if not is_macos():
        return ""
    return run_command(["system_profiler", "SPHardwareDataType"], timeout=30)


def collect_source_fingerprint():
    if is_macos():
        output = run_command(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', output)
        if match:
            return match.group(1).strip().lower()
    for candidate in (
        "/etc/machine-id",
        "/var/lib/dbus/machine-id",
        "/sys/class/dmi/id/product_uuid",
        "/sys/class/dmi/id/product_serial",
    ):
        value = read_text(candidate).strip().lower()
        if value:
            return value
    return collect_hostname().lower()


def collect_hostname():
    return socket.gethostname().strip()


def build_default_asset_tag(hostname, source_fingerprint):
    hostname_key = "".join(ch for ch in hostname.upper() if ch.isalnum()) or "SYSTEM"
    suffix = "".join(ch for ch in source_fingerprint.upper() if ch.isalnum())[:8]
    if not suffix:
        return hostname_key[:20]
    prefix_length = max(1, 20 - len(suffix) - 1)
    return f"{hostname_key[:prefix_length]}-{suffix}"


def collect_salt_minion_id():
    for path in ["/etc/salt/minion_id", "/opt/homebrew/etc/salt/minion_id", "/usr/local/etc/salt/minion_id"]:
        minion_id = read_text(path)
        if minion_id:
            return minion_id
    if not run_command(["bash", "-lc", "command -v salt-call >/dev/null 2>&1 && echo yes"]):
        return ""
    detected = run_command(["bash", "-lc", "salt-call --local grains.get id --out=newline_values_only 2>/dev/null | tail -n 1"])
    return detected.strip()


def collect_wazuh_agent_id():
    for path in ["/var/ossec/etc/client.keys", "/Library/Ossec/etc/client.keys"]:
        content = read_text(path)
        if not content:
            continue
        first_line = content.splitlines()[0].strip()
        if not first_line:
            continue
        parts = first_line.split()
        if parts:
            agent_id = parts[0].strip()
            if agent_id.isdigit():
                return agent_id
        if len(parts) >= 2:
            return parts[1].strip()
    return ""


def read_chassis_type():
    value = read_text("/sys/class/dmi/id/chassis_type") or read_text("/sys/devices/virtual/dmi/id/chassis_type")
    return value.strip()


def infer_asset_category(requested_category, manufacturer, model):
    normalized = (requested_category or "").strip().lower()
    if normalized and normalized != "auto":
        return normalized

    virtualization = run_command(["systemd-detect-virt"])
    model_text = f"{manufacturer} {model}".lower()
    virtual_markers = ["virtualbox", "vmware", "kvm", "qemu", "hyper-v", "virtual machine", "bochs"]
    if virtualization and virtualization != "none":
        return "vm"
    if any(marker in model_text for marker in virtual_markers):
        return "vm"

    if is_macos() and "InternalBattery" in run_command(["pmset", "-g", "batt"]):
        return "laptop"

    chassis_type = read_chassis_type()
    if chassis_type in {"8", "9", "10", "14"}:
        return "laptop"

    return "desktop"


def collect_bios_version():
    return read_text("/sys/class/dmi/id/bios_version") or ""


def collect_os_details():
    if is_macos():
        product_name = run_command(["sw_vers", "-productName"]) or "macOS"
        product_version = run_command(["sw_vers", "-productVersion"]) or platform.mac_ver()[0]
        build_version = run_command(["sw_vers", "-buildVersion"]) or platform.version()
        return f"{product_name} {product_version}".strip(), product_version, platform.release(), platform.machine() or "unknown", build_version
    os_release = parse_os_release()
    os_name = os_release.get("PRETTY_NAME") or f"{platform.system()} {platform.release()}".strip()
    os_version = os_release.get("VERSION_ID") or platform.release()
    kernel = platform.release()
    architecture = platform.machine() or "unknown"
    os_build = platform.version()
    return os_name, os_version, kernel, architecture, os_build


def scan_status(status, source, **extra):
    return dict(status=status, source=source,
                scanned_at=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), **extra)


def scan_command(command, timeout=60, valid_codes=(0,)):
    """Read-only scans: never hide missing commands, failures or timeouts as empty output."""
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True,
                                timeout=timeout, env=dict(os.environ, LC_ALL="C", LANG="C"))
    except subprocess.TimeoutExpired:
        return "", "timeout"
    except OSError:
        return "", "command unavailable"
    if result.returncode not in valid_codes:
        return "", "command failed (exit %d)" % result.returncode
    return result.stdout.strip(), ""


def collect_update_scan(limit=5000):
    source = ""
    if is_macos():
        source, command = "softwareupdate", ["/usr/sbin/softwareupdate", "--list"]
    elif command_exists("apt"):
        source, command = "apt", ["apt", "list", "--upgradable"]
    elif command_exists("dnf") or command_exists("yum"):
        source = "dnf" if command_exists("dnf") else "yum"
        command = [source, "-q", "--cacheonly", "check-update"]
    else:
        return None, [], None, scan_status("unsupported", "none")
    output, error = scan_command(command, timeout=120, valid_codes=(0, 100) if source in ("dnf", "yum") else (0,))
    if error:
        return None, [], None, scan_status("failed", source, error=error)
    details = []
    for line in output.splitlines():
        if source == "softwareupdate":
            match = re.match(r"\s*\*\s*(?:Label:\s*)?(.+)", line)
            if match:
                details.append(match.group(1).strip())
        elif source == "apt":
            if re.match(r"^[\w.+:-]+/\S+\s+\S+", line):
                details.append(line.strip())
        elif re.match(r"^[\w.+:-]+\.(?:x86_64|noarch|i[3-6]86|aarch64|arm\w*|ppc\w*|s390x)\s+\S+\s+\S+", line):
            details.append(line.strip())
    details = sorted(set(details))
    # Unknown softwareupdate output must not masquerade as a clean scan.
    if source == "softwareupdate" and not details and "No new software available" not in output:
        return None, [], None, scan_status("failed", source, error="unrecognized update response")
    if source in ("dnf", "yum") and output and not details:
        return None, [], None, scan_status("failed", source, error="unrecognized update response")
    if source == "apt" and not details and not output.startswith("Listing"):
        return None, [], None, scan_status("failed", source, error="unrecognized update response")
    reboot = Path("/var/run/reboot-required").exists() if source == "apt" else None
    if source == "softwareupdate":
        reboot = "restart" in output.lower() if details else False
    partial = len(details) > limit
    return (None if partial else len(details)), details[:limit], reboot, scan_status(
        "partial" if partial else "success", source, total=len(details), returned=min(limit, len(details)),
        truncated=partial, scope="OS package updates; cached repository metadata on Linux")


def collect_logged_in_users():
    users = []
    seen = set()

    def add_candidate(value):
        candidate = (value or "").strip()
        if not candidate or candidate in seen:
            return
        seen.add(candidate)
        users.append(candidate)

    for line in run_command(["who"]).splitlines():
        parts = line.split()
        if parts:
            add_candidate(parts[0])

    loginctl_output = run_command(["bash", "-lc", "loginctl list-sessions --no-legend 2>/dev/null"])
    for line in loginctl_output.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            add_candidate(parts[2])

    add_candidate(os.getenv("SUDO_USER", ""))
    return users


def collect_network_details():
    if is_macos():
        return collect_macos_network_details()
    if not command_exists("ip"):
        return {
            "wired_ip": "",
            "wireless_ip": "",
            "netbird_ip": "",
            "dns": "",
            "gateway": "",
            "interface_stats": {},
        }

    output = run_command(["ip", "-j", "addr", "show"])
    try:
        interfaces = json.loads(output) if output else []
    except json.JSONDecodeError:
        interfaces = []

    wired_ip = ""
    wireless_ip = ""
    netbird_ip = ""
    interface_stats = {}
    ignored_prefixes = ("lo", "docker", "br-", "veth", "virbr")

    for item in interfaces:
        interface_name = str(item.get("ifname", "")).strip()
        if not interface_name or interface_name.startswith(ignored_prefixes):
            continue
        if item.get("operstate") == "DOWN":
            continue

        addresses = []
        for addr_info in item.get("addr_info", []):
            if addr_info.get("family") != "inet":
                continue
            local_address = str(addr_info.get("local", "")).strip()
            if not local_address or local_address.startswith("127."):
                continue
            addresses.append(local_address)
        if not addresses:
            continue

        interface_stats[interface_name] = {
            "mtu": item.get("mtu"),
            "state": item.get("operstate"),
            "mac": item.get("address", ""),
            "addresses": addresses,
        }

        primary_address = addresses[0]
        normalized_name = interface_name.lower()
        if normalized_name.startswith("netbird") or normalized_name.startswith("wt"):
            if not netbird_ip:
                netbird_ip = primary_address
            continue
        if normalized_name.startswith("wl") or "wifi" in normalized_name or "wlan" in normalized_name:
            if not wireless_ip:
                wireless_ip = primary_address
            continue
        if not wired_ip:
            wired_ip = primary_address

    dns_servers = []
    for line in read_text("/etc/resolv.conf").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "nameserver":
            dns_servers.append(parts[1].strip())

    gateway = ""
    route_output = run_command(["ip", "route", "show", "default"])
    for line in route_output.splitlines():
        parts = line.split()
        if not parts or parts[0] != "default":
            continue
        if "via" in parts:
            via_index = parts.index("via")
            if via_index + 1 < len(parts):
                gateway = parts[via_index + 1].strip()
                break

    return {
        "wired_ip": wired_ip,
        "wireless_ip": wireless_ip,
        "netbird_ip": netbird_ip,
        "dns": ", ".join(dns_servers),
        "gateway": gateway,
        "interface_stats": interface_stats,
    }


def collect_macos_network_details():
    hardware_ports = {}
    current_port = ""
    for line in run_command(["networksetup", "-listallhardwareports"]).splitlines():
        stripped = line.strip()
        if stripped.startswith("Hardware Port:"):
            current_port = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("Device:") and current_port:
            hardware_ports[stripped.split(":", 1)[1].strip()] = current_port

    interface_stats = {}
    wired_ip = ""
    wireless_ip = ""
    netbird_ip = ""
    current_interface = ""
    for line in run_command(["ifconfig"]).splitlines():
        if line and not line[0].isspace() and ":" in line:
            current_interface = line.split(":", 1)[0]
            continue
        if not current_interface:
            continue
        inet_match = re.match(r"\s+inet\s+(\d+\.\d+\.\d+\.\d+)", line)
        if not inet_match or inet_match.group(1).startswith("127."):
            continue
        address = inet_match.group(1)
        details = interface_stats.setdefault(current_interface, {
            "state": "UP",
            "mac": "",
            "addresses": [],
            "hardware_port": hardware_ports.get(current_interface, ""),
        })
        details["addresses"].append(address)
        normalized_name = current_interface.lower()
        hardware_port = hardware_ports.get(current_interface, "").lower()
        if normalized_name.startswith(("utun", "netbird")):
            netbird_ip = netbird_ip or address
        elif "wi-fi" in hardware_port or "airport" in hardware_port:
            wireless_ip = wireless_ip or address
        else:
            wired_ip = wired_ip or address

    for line in run_command(["ifconfig"]).splitlines():
        if line and not line[0].isspace() and ":" in line:
            current_interface = line.split(":", 1)[0]
            continue
        mac_match = re.match(r"\s+ether\s+([0-9a-f:]{17})", line, re.IGNORECASE)
        if mac_match and current_interface in interface_stats:
            interface_stats[current_interface]["mac"] = mac_match.group(1).lower()

    dns_servers = []
    for line in run_command(["scutil", "--dns"]).splitlines():
        match = re.match(r"\s*nameserver\[\d+\]\s*:\s*(\S+)", line)
        if match and match.group(1) not in dns_servers:
            dns_servers.append(match.group(1))

    route_output = run_command(["route", "-n", "get", "default"])
    gateway_match = re.search(r"gateway:\s+(\S+)", route_output)
    return {
        "wired_ip": wired_ip,
        "wireless_ip": wireless_ip,
        "netbird_ip": netbird_ip,
        "dns": ", ".join(dns_servers),
        "gateway": gateway_match.group(1) if gateway_match else "",
        "interface_stats": interface_stats,
    }


def brew_executable():
    return shutil.which("brew") or next((p for p in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew") if Path(p).is_file()), None)


def desktop_entry_metadata(text):
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str
    try:
        parser.read_string(text)
        entry = parser["Desktop Entry"]
        categories = set(entry.get("Categories", "").split(";"))
        if (entry.get("Type") != "Application" or not entry.get("Name")
                or not entry.get("Exec")
                or entry.get("Hidden", "false").lower() == "true"
                or entry.get("NoDisplay", "false").lower() == "true"
                or categories.intersection({"System", "Settings"})):
            return None
        return dict(entry)
    except (configparser.Error, KeyError):
        return None


def classify_linux_desktop_software(entries):
    launchers, failures = {}, []
    for root in (Path("/usr/share/applications"), Path("/usr/local/share/applications"),
                 Path("/var/lib/snapd/desktop/applications"),
                 Path("/var/lib/flatpak/exports/share/applications"),
                 Path.home() / ".local/share/flatpak/exports/share/applications"):
        try:
            with os.scandir(root) as directory:
                for index, child in enumerate(directory):
                    if index >= 2000:
                        failures.append("desktop entries: coverage bounded")
                        break
                    if not child.name.endswith(".desktop"):
                        continue
                    try:
                        with Path(child.path).open(encoding="utf-8", errors="replace") as handle:
                            text = handle.read(65537)
                        if len(text) > 65536:
                            failures.append("desktop entries: metadata bounded")
                            continue
                        metadata = desktop_entry_metadata(text)
                        if metadata:
                            launchers[child.path] = metadata
                    except OSError:
                        failures.append("desktop entries: metadata unavailable")
        except FileNotFoundError:
            continue
        except OSError:
            failures.append("desktop entries: directory unavailable")
    owners = set()
    paths = sorted(launchers)
    provider = "dpkg" if command_exists("dpkg-query") else "rpm" if command_exists("rpm") else ""
    deadline = time.monotonic() + 30
    for offset in range(0, len(paths), 200):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            failures.append("desktop entries: ownership scan timed out")
            break
        batch = paths[offset:offset + 200]
        if provider == "dpkg":
            output, error = scan_command(["dpkg-query", "-S", *batch], timeout=min(10, remaining), valid_codes=(0, 1))
            for line in output.splitlines():
                package, separator, path = line.rpartition(": ")
                if separator and path in launchers:
                    owners.add(package)
        elif provider == "rpm":
            output, error = scan_command(["rpm", "-qf", "--qf", "%{NAME}\n", *batch], timeout=min(10, remaining), valid_codes=(0, 1))
            owners.update(output.splitlines())
        else:
            continue
        if error:
            failures.append("desktop entries: some package owners unavailable")
    snaps = {entry.get("X-SnapInstanceName") for entry in launchers.values()}
    flatpaks = {entry.get("X-Flatpak") for entry in launchers.values()}
    for entry in entries:
        source = entry["source"]
        if ((source == provider and entry["name"] in owners)
                or (source == "snap" and entry["name"] in snaps)
                or (source == "flatpak" and entry["name"] in flatpaks)):
            entry["source"] = source + "_desktop"
    return failures


def collect_software_scan(limit=5000):
    """Bounded package databases and known app directories, not arbitrary user files."""
    limit = max(1, min(limit, 10000))
    entries, sources, failures = [], [], []

    def query(source, command):
        sources.append(source)
        output, error = scan_command(command)
        if error:
            failures.append(source + ": " + error)
        return output

    def add(name, version, source):
        if name:
            entries.append(dict(name=name, version=version, source=source, install_date=""))

    if is_macos():
        brew = brew_executable()
        if brew:
            for line in query("homebrew", [brew, "list", "--versions"]).splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    add(parts[0], " ".join(parts[1:]), "homebrew")
                else:
                    failures.append("homebrew: unrecognized package response")
        sources.append("app_bundle")
        for root in (Path("/Applications"), Path("/System/Applications"), Path.home() / "Applications"):
            try:
                # glob can suppress permission errors and falsely certify an empty
                # inventory. scandir exposes them; traverse only one category level.
                with os.scandir(root) as directory:
                    children = list(directory)
                bundles = []
                for child in children:
                    if child.name.endswith(".app"):
                        bundles.append(Path(child.path))
                    elif child.is_dir(follow_symlinks=False):
                        try:
                            with os.scandir(child.path) as directory:
                                bundles.extend(Path(entry.path) for entry in directory if entry.name.endswith(".app"))
                        except OSError:
                            failures.append("app_bundle: directory unavailable")
                for bundle in bundles:
                    try:
                        with (bundle / "Contents/Info.plist").open("rb") as handle:
                            info = plistlib.load(handle)
                        if not isinstance(info, dict):
                            raise ValueError("expected app metadata dictionary")
                        identifier = str(info.get("CFBundleIdentifier") or "")
                        source = "app_bundle_desktop" if identifier and not identifier.startswith("com.apple.") and root != Path("/System/Applications") else "app_bundle"
                        add(str(info.get("CFBundleDisplayName") or info.get("CFBundleName") or bundle.stem),
                            str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or ""), source)
                    except (OSError, ValueError, plistlib.InvalidFileException):
                        failures.append("app_bundle: unreadable metadata")
            except FileNotFoundError:
                continue
            except OSError:
                failures.append("app_bundle: directory unavailable")
    else:
        if command_exists("dpkg-query"):
            for line in query("dpkg", ["dpkg-query", "-W", "-f=${db:Status-Status}\t${binary:Package}\t${Version}\n"]).splitlines():
                parts = line.split("\t")
                if len(parts) == 3 and parts[0] == "installed":
                    add(parts[1], parts[2], "dpkg")
                elif len(parts) != 3:
                    failures.append("dpkg: unrecognized package response")
        elif command_exists("rpm"):
            for line in query("rpm", ["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}.%{ARCH}\n"]).splitlines():
                parts = line.split("\t")
                if len(parts) == 2:
                    add(parts[0], parts[1], "rpm")
                else:
                    failures.append("rpm: unrecognized package response")
        for source, command in (("snap", ["snap", "list"]),
                                ("flatpak", ["flatpak", "list", "--app", "--columns=application,version"])):
            if not command_exists(source):
                continue
            output = query(source, command)
            if source == "snap" and output and not output.splitlines()[0].split()[:2] == ["Name", "Version"]:
                failures.append("snap: unrecognized package response")
                continue
            for line in output.splitlines()[1 if source == "snap" else 0:]:
                parts = line.split() if source == "snap" else line.split("\t")
                if len(parts) >= 2 and parts[0]:
                    add(parts[0], parts[1] if len(parts) > 1 else "", source)
                else:
                    failures.append(source + ": unrecognized package response")
    for source, command in (("pip", ["pip3", "list", "--user", "--format=json"]),
                            ("npm", ["npm", "list", "-g", "--depth=0", "--json"])):
        if not command_exists(command[0]):
            continue
        raw = query(source, command)
        if not raw:
            failures.append(source + ": missing JSON response")
            continue
        try:
            parsed = json.loads(raw)
            if source == "pip" and not isinstance(parsed, list):
                raise ValueError("expected package list")
            if source == "npm" and not isinstance(parsed, dict):
                raise ValueError("expected package object")
            packages = parsed if source == "pip" else [dict(name=k, version=v.get("version", "")) for k, v in parsed.get("dependencies", {}).items()]
            for item in packages:
                if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
                    failures.append(source + ": invalid package row")
                    continue
                add(str(item.get("name", "")), str(item.get("version", "")), source)
        except (ValueError, TypeError, AttributeError):
            failures.append(source + ": invalid response")
    if not is_macos():
        failures.extend(classify_linux_desktop_software(entries))
    unique = {(e["source"], e["name"], e["version"]): e for e in entries}
    entries = [unique[key] for key in sorted(unique)]
    truncated = len(entries) > limit
    status = "unsupported" if not sources else ("partial" if truncated or failures else "success")
    if failures and not entries:
        status = "failed"
    return entries[:limit], scan_status(status, ",".join(sources) or "none", total=len(entries),
        returned=min(len(entries), limit), truncated=truncated, error="; ".join(sorted(set(failures)))[:500],
        scope="native package databases, known app roots, current collector user pip and global npm; portable/unloaded user apps not guaranteed")


def collect_service_scan(limit=5000):
    """Service metadata only: never read unit/plist commands, environments or credentials."""
    limit = max(1, min(limit, 10000))
    entries, failures = {}, []
    source = "launchctl" if is_macos() else "systemd"
    scope = ("loaded system-domain launchd jobs only (root); unloaded jobs and user domains excluded"
             if is_macos() else "system service unit files plus all loaded system service units; user units excluded")

    def add(name, state="unknown", mode="unknown"):
        # Do not invent a different service identity by silently shortening it.
        if not name or len(name) > 256 or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name):
            failures.append("invalid or overlong service identifier")
            return
        if len(state) > 64 or len(mode) > 64:
            failures.append("invalid service state metadata")
            state, mode = "unknown", "unknown"
        entries[name] = dict(name=name, display_name=name, state=state,
                             start_mode=mode, source=source)

    def query(command):
        output, error = scan_command(command)
        if error:
            failures.append("service query failed or timed out")
        return output

    if is_macos():
        if os.geteuid() != 0 or not command_exists("launchctl"):
            return [], scan_status("unsupported", source, scope=scope, total=0, returned=0,
                                   error="system-domain scan requires root and launchctl")
        output = query(["launchctl", "list"])
        lines = output.splitlines()
        if not lines or lines[0].split() != ["PID", "Status", "Label"]:
            failures.append("unrecognized service response")
        else:
            for line in lines[1:]:
                parts = line.split()
                if len(parts) != 3 or not (parts[0] == "-" or parts[0].isdigit()) or not parts[1].lstrip("-").isdigit():
                    failures.append("unrecognized service response")
                    continue
                add(parts[2], "running" if parts[0].isdigit() else "stopped")
    elif platform.system() == "Linux" and command_exists("systemctl"):
        files = query(["systemctl", "list-unit-files", "--type=service", "--no-pager", "--no-legend", "--full"])
        for line in files.splitlines():
            parts = line.split()
            if len(parts) not in (2, 3) or not parts[0].endswith(".service"):
                failures.append("unrecognized service response")
                continue
            add(parts[0], mode=parts[1])
        units = query(["systemctl", "list-units", "--all", "--type=service", "--no-pager", "--no-legend", "--plain", "--full"])
        for line in units.splitlines():
            parts = line.split()
            if len(parts) < 4 or not parts[0].endswith(".service"):
                failures.append("unrecognized service response")
                continue
            mode = entries.get(parts[0], {}).get("start_mode", "unknown")
            # Ignore freeform descriptions; runtime substate distinguishes stopped/failed jobs.
            add(parts[0], state=parts[2] + "/" + parts[3], mode=mode)
    else:
        return [], scan_status("unsupported", source, scope=scope, total=0, returned=0)
    rows = [entries[key] for key in sorted(entries)]
    truncated = len(rows) > limit
    status = "partial" if failures or truncated else "success"
    if failures and not rows:
        status = "failed"
    return rows[:limit], scan_status(status, source, scope=scope, total=len(rows),
        returned=min(limit, len(rows)), truncated=truncated, truncated_count=max(0, len(rows) - limit),
        error="; ".join(sorted(set(failures))))


def collect_installed_software(limit=5000):
    return collect_software_scan(limit)[0]


def collect_clamav_report(scan_paths, timeout):
    scanner = shutil.which("clamscan") or shutil.which("clamdscan")
    if not scanner:
        return None

    resolved_paths = []
    for path in scan_paths:
        if not path:
            continue
        candidate = Path(path)
        if candidate.exists():
            resolved_paths.append(str(candidate))
    if not resolved_paths:
        resolved_paths = ["/"]

    command = [scanner, "--recursive", "--infected", *resolved_paths]
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "source": "clamav",
            "status": "error",
            "severity": "warning",
            "title": "ClamAV scan failed",
            "summary": f"ClamAV scan failed before completion: {error}",
            "detail": str(error),
            "scanned_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "scanned_paths": resolved_paths,
            "error_count": 1,
        }

    output_parts = [part for part in [result.stdout.strip(), result.stderr.strip()] if part]
    output = "\n".join(output_parts)
    infected_files = []
    summary = {}
    in_summary = False
    for line in output.splitlines():
        stripped = line.strip()
        if stripped == "----------- SCAN SUMMARY -----------":
            in_summary = True
            continue
        if in_summary:
            if ":" not in stripped:
                continue
            key, value = stripped.split(":", 1)
            summary[key.strip().lower()] = value.strip()
            continue
        if stripped.endswith(" FOUND") and ":" in stripped:
            infected_files.append(stripped.rsplit(":", 1)[0].strip())

    infected_count = parse_summary_count(summary.get("infected files", "")) or len(infected_files)
    scanned_count = parse_summary_count(summary.get("scanned files", ""))
    error_count = parse_summary_count(summary.get("total errors", ""))

    status = "clean"
    severity = "info"
    title = "ClamAV scan clean"
    if result.returncode == 1 or infected_count > 0:
        status = "infected"
        severity = "high"
        title = "ClamAV detected threats"
    elif result.returncode not in (0, 1):
        status = "error"
        severity = "warning"
        title = "ClamAV scan failed"

    summary_text = f"Scanned {scanned_count or 'unknown'} files; infected: {infected_count}; errors: {error_count}."
    detail_lines = []
    if output:
        detail_lines = output.splitlines()[-40:]

    return {
        "source": "clamav",
        "status": status,
        "severity": severity,
        "title": title,
        "summary": summary_text,
        "detail": "\n".join(detail_lines),
        "scanned_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "scanned_paths": resolved_paths,
        "infected_files": infected_files[:20],
        "scanned_file_count": scanned_count,
        "infected_file_count": infected_count,
        "error_count": error_count,
    }


def parse_trivy_report(payload, scanned_at=None):
    vulnerabilities = []
    severity_counts = {}
    for result in payload.get("Results") or []:
        for vulnerability in result.get("Vulnerabilities") or []:
            severity = str(vulnerability.get("Severity") or "UNKNOWN").upper()
            severity_counts[severity] = severity_counts.get(severity, 0) + 1
            vulnerabilities.append(vulnerability)

    total = len(vulnerabilities)
    severity_order = ("CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN")
    highest = next((severity for severity in severity_order if severity_counts.get(severity)), "UNKNOWN")
    report_severity = {
        "CRITICAL": "critical",
        "HIGH": "high",
        "MEDIUM": "medium",
        "LOW": "warning",
        "UNKNOWN": "info",
    }[highest]
    summary = "; ".join(
        [f"Vulnerabilities: {total}"]
        + [f"{severity.lower()}: {severity_counts[severity]}" for severity in severity_order if severity_counts.get(severity)]
    ) + "."
    detail_lines = []
    for vulnerability in vulnerabilities[:20]:
        vulnerability_id = str(vulnerability.get("VulnerabilityID") or "Unknown CVE")
        package = str(vulnerability.get("PkgName") or "unknown package")
        installed = str(vulnerability.get("InstalledVersion") or "unknown")
        fixed = str(vulnerability.get("FixedVersion") or "unavailable")
        severity = str(vulnerability.get("Severity") or "UNKNOWN").upper()
        detail_lines.append(f"{vulnerability_id} [{severity}] {package} {installed} (fixed: {fixed})")

    return {
        "source": "cve",
        "status": "vulnerable" if total else "clean",
        "severity": report_severity,
        "title": "CVE vulnerabilities detected" if total else "CVE scan clean",
        "summary": summary,
        "detail": "\n".join(detail_lines),
        "scanned_at": scanned_at or datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "scanned_paths": [],
        "scanned_file_count": total,
        "infected_file_count": 0,
        "error_count": 0,
    }


def collect_cve_report(scan_target, timeout):
    scanner = shutil.which("trivy")
    if not scanner:
        return None

    command = [scanner, "rootfs", "--format", "json", "--scanners", "vuln", "--quiet", scan_target]
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "source": "cve",
            "status": "error",
            "severity": "warning",
            "title": "CVE scan failed",
            "summary": f"Trivy scan failed before completion: {error}",
            "detail": str(error),
            "scanned_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "error_count": 1,
        }

    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return {
            "source": "cve",
            "status": "error",
            "severity": "warning",
            "title": "CVE scan failed",
            "summary": f"Trivy exited with status {result.returncode}.",
            "detail": truncate_output(detail),
            "scanned_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "error_count": 1,
        }

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return {
            "source": "cve",
            "status": "error",
            "severity": "warning",
            "title": "CVE scan failed",
            "summary": "Trivy returned invalid JSON.",
            "detail": str(error),
            "scanned_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "error_count": 1,
        }

    report = parse_trivy_report(payload)
    report["scanned_paths"] = [scan_target]
    return report


def find_latest_openscap_result(results_dir):
    if not results_dir:
        return None
    base_dir = Path(results_dir)
    if not base_dir.exists():
        return None
    candidates = sorted(base_dir.glob("openscap-results-*.xml"), key=lambda path: path.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def local_name(tag):
    return tag.split("}", 1)[1] if tag.startswith("{") and "}" in tag else tag


def openscap_rule_result(element):
    result = element.attrib.get("result", "").strip().lower()
    if result:
        return result

    for child in element:
        if local_name(child.tag) != "result":
            continue
        text = (child.text or "").strip().lower()
        if text:
            return text

    return "unknown"


def collect_openscap_report(results_dir):
    latest_result = find_latest_openscap_result(results_dir)
    if latest_result is None:
        return None

    try:
        tree = ET.parse(latest_result)
        root = tree.getroot()
    except (ET.ParseError, OSError) as error:
        return {
            "source": "openscap",
            "status": "error",
            "severity": "warning",
            "title": "OpenSCAP hardening report unavailable",
            "summary": f"Failed to parse OpenSCAP result file {latest_result.name}.",
            "detail": str(error),
            "scanned_at": datetime.datetime.fromtimestamp(latest_result.stat().st_mtime, tz=datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }

    benchmark_title = ""
    title_map = {}
    for element in root.iter():
        name = local_name(element.tag)
        if name == "Benchmark" and not benchmark_title:
            title_node = next((child for child in element if local_name(child.tag) == "title" and (child.text or "").strip()), None)
            if title_node is not None:
                benchmark_title = (title_node.text or "").strip()
        if name == "Rule":
            rule_id = element.attrib.get("id", "").strip()
            title_node = next((child for child in element if local_name(child.tag) == "title" and (child.text or "").strip()), None)
            if rule_id and title_node is not None:
                title_map[rule_id] = (title_node.text or "").strip()

    counts = {}
    failed_rules = []
    for element in root.iter():
        if local_name(element.tag) != "rule-result":
            continue
        result = openscap_rule_result(element)
        counts[result] = counts.get(result, 0) + 1
        if result not in {"fail", "error", "unknown"}:
            continue
        rule_id = element.attrib.get("idref", "").strip()
        rule_title = title_map.get(rule_id, "")
        failed_rules.append(f"{rule_id}: {rule_title}".strip(": "))

    fail_count = counts.get("fail", 0)
    error_count = counts.get("error", 0)
    pass_count = counts.get("pass", 0)
    informational_count = counts.get("informational", 0)
    notapplicable_count = counts.get("notapplicable", 0)
    notchecked_count = counts.get("notchecked", 0)
    fixed_count = counts.get("fixed", 0)
    total_rules = sum(counts.values())
    status = "compliant"
    severity = "info"
    title = "OpenSCAP hardening check passed"
    if fail_count > 0:
        status = "noncompliant"
        severity = "medium"
        title = "OpenSCAP hardening findings"
    elif error_count > 0:
        status = "error"
        severity = "warning"
        title = "OpenSCAP hardening scan failed"

    summary = (
        f"Rules checked: {total_rules}; passed: {pass_count}; failed: {fail_count}; errors: {error_count}; "
        f"not-applicable: {notapplicable_count}; informational: {informational_count}; not-checked: {notchecked_count}; fixed: {fixed_count}."
    )
    detail_lines = []
    if benchmark_title:
        detail_lines.append(benchmark_title)
    detail_lines.append(summary)
    if failed_rules:
        detail_lines.append("Top failed rules:")
        detail_lines.extend(f"- {item}" for item in failed_rules[:20])

    report_file = latest_result.with_name(latest_result.name.replace("results", "report").replace(".xml", ".html"))
    scanned_at = datetime.datetime.fromtimestamp(latest_result.stat().st_mtime, tz=datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "source": "openscap",
        "status": status,
        "severity": severity,
        "title": title,
        "summary": summary,
        "detail": "\n".join(detail_lines),
        "scanned_at": scanned_at,
        "scanned_paths": [str(results_dir)],
        "scanned_file_count": total_rules,
        "infected_file_count": fail_count,
        "error_count": error_count,
        "artifact_files": [str(latest_result)] + ([str(report_file)] if report_file.exists() else []),
    }


def normalize_endpoint(server_url):
    parsed = urllib.parse.urlparse(server_url)
    if not parsed.scheme:
        server_url = f"http://{server_url}"
        parsed = urllib.parse.urlparse(server_url)

    if parsed.path.endswith("/api/inventory-sync/ingest"):
        return server_url

    base_path = parsed.path.rstrip("/")
    endpoint_path = f"{base_path}/api/inventory-sync/ingest" if base_path else "/api/inventory-sync/ingest"
    normalized = parsed._replace(path=endpoint_path, params="", query="", fragment="")
    return urllib.parse.urlunparse(normalized)


def build_asset_payload(args):
    hostname = collect_hostname()
    os_name, os_version, kernel, architecture, os_build = collect_os_details()
    source_fingerprint = args.source_fingerprint or collect_source_fingerprint()
    asset_tag = args.asset_tag or build_default_asset_tag(hostname, source_fingerprint)
    manufacturer = collect_manufacturer()
    model = collect_model()
    serial_number = collect_serial_number()
    category = infer_asset_category(args.category, manufacturer, model)
    salt_minion_id = args.salt_minion_id or collect_salt_minion_id()
    wazuh_agent_id = args.wazuh_agent_id or collect_wazuh_agent_id()
    network_details = collect_network_details()
    volume_details = collect_volume_details()
    pending_count, pending_details, reboot, update_status = collect_update_scan()
    software, software_status = ([], scan_status("uncollected", "none")) if args.no_software_scan else collect_software_scan(args.software_limit)
    services, service_status = collect_service_scan(args.service_limit)
    asset_payload = {
        "asset_tag": asset_tag,
        "name": args.name or hostname,
        "hostname": hostname,
        "category": category,
        "is_compute": True,
        "serial_number": serial_number,
        "manufacturer": manufacturer,
        "model": model,
        "entity_id": args.entity_id,
        "dept_id": args.dept_id,
        "location_id": args.location_id,
        "assigned_to_email": args.assigned_to_email,
        "assigned_to_name": args.assigned_to_name,
        "employee_code": args.employee_code,
        "department_name": args.department_name,
        "purchase_date": args.purchase_date,
        "warranty_until": args.warranty_until,
        "status": args.status,
        "condition": args.condition,
        "source_fingerprint": source_fingerprint,
        "salt_minion_id": salt_minion_id,
        "wazuh_agent_id": wazuh_agent_id,
        "notes": args.notes,
        "compute_details": {
            "processor": collect_processor(),
            "ram": collect_memory(),
            "storage": collect_storage(),
            "gpu": collect_gpu(),
            "display": collect_display(args.use_hardinfo_fallback),
            "bios_version": collect_bios_version(),
            "mac_address": collect_primary_mac_address(),
            "os_name": os_name,
            "os_version": os_version,
            "kernel": kernel,
            "architecture": architecture,
            "os_build": os_build,
            "last_boot": collect_last_boot(),
            "last_seen": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "logged_in_users": collect_logged_in_users(),
            "pending_updates": pending_count,
            "pending_update_details": pending_details,
            "reboot_required": reboot,
            "anydesk_id": collect_remote_access_id("anydesk"),
            "rustdesk_id": collect_remote_access_id("rustdesk"),
            "disk_layout": collect_disk_layout(),
            "volumes": volume_details,
        },
        "network": network_details,
        "installed_software": software,
        "services": services,
        "collection_status": {"software": software_status, "updates": update_status, "services": service_status},
    }
    hardware = asset_payload["compute_details"]
    # Legacy system helpers suppress individual command failures. Populated fields
    # alone cannot prove that every hardware/network provider completed its scan.
    asset_payload["collection_status"]["hardware"] = scan_status(
        "partial", "macos_system_tools" if is_macos() else "linux_system_tools",
        scope="best-effort system fields; provider completion unverified; macOS volumes cover root only")
    asset_payload["collection_status"]["network"] = scan_status(
        "partial", "system_network_tools",
        scope="best-effort visible IPv4 interfaces, routes and DNS; provider completion unverified")
    asset_payload["collection_status"]["remote_access"] = scan_status(
        "partial" if hardware["anydesk_id"] or hardware["rustdesk_id"] else "uncollected", "installed_executable_get_id",
        scope="numeric local AnyDesk/RustDesk IDs only; absent IDs are unavailable, never passwords")
    security_reports = []
    if args.include_clamav_report:
        clamav_report = collect_clamav_report(args.clamav_scan_paths, args.clamav_timeout)
        if clamav_report:
            security_reports.append(clamav_report)
    if args.include_openscap_report:
        openscap_report = collect_openscap_report(args.openscap_results_dir)
        if openscap_report:
            security_reports.append(openscap_report)
    if args.include_cve_report:
        cve_report = collect_cve_report(args.cve_scan_target, args.cve_timeout)
        if cve_report:
            security_reports.append(cve_report)
    if security_reports:
        asset_payload["security_reports"] = security_reports

    payload = {
        "assets": [
            asset_payload
        ]
    }
    return payload


def post_payload(endpoint, token, payload, timeout):
    data = json.dumps(payload).encode("utf-8")
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        request = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt == max_attempts:
                raise
        except urllib.error.URLError:
            if attempt == max_attempts:
                raise

        time.sleep(min(2 ** (attempt - 1), 4))


def send_heartbeat(args, token):
    hostname = collect_hostname()
    asset_tag = args.asset_tag or build_default_asset_tag(
        hostname, args.source_fingerprint or collect_source_fingerprint())
    payload = {"asset_tag": asset_tag}
    if args.print_only:
        print(json.dumps(payload))
        return 0
    if not token:
        sys.stderr.write("Heartbeat not sent: missing ingest token.\n")
        return 1
    parsed = urllib.parse.urlparse(normalize_endpoint(args.server_url))
    endpoint = urllib.parse.urlunparse(parsed._replace(
        path=parsed.path[:-len("/inventory-sync/ingest")] + "/assets/heartbeat", params="", query="", fragment=""))
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                                     method="PUT")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, new_url):
            return None

    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            if response.status != 200:
                sys.stderr.write("Heartbeat rejected by server.\n")
                return 1
    except (OSError, urllib.error.URLError):
        sys.stderr.write("Heartbeat failed; waiting for the next scheduled check.\n")
        return 1
    return 0


def parse_args():
    parser = argparse.ArgumentParser(description="Collect hardware and OS details from a Linux or macOS system and push them to the ITMS backend.")
    parser.add_argument("--server-url", default=os.getenv("ITMS_SERVER_URL", "http://localhost:3001"), help="Backend base URL or full ingest endpoint")
    parser.add_argument("--token-file", default="", help="Read the inventory ingest token from FILE")
    parser.add_argument("--prompt-token", action="store_true", help="Prompt for the inventory ingest token without echo")
    parser.add_argument("--asset-tag", default=os.getenv("ITMS_ASSET_TAG", ""), help="Asset tag to report. Defaults to hostname plus a stable device suffix")
    parser.add_argument("--name", default=os.getenv("ITMS_ASSET_NAME", ""), help="Friendly asset name. Defaults to hostname")
    parser.add_argument("--category", default=os.getenv("ITMS_ASSET_CATEGORY", "auto"), help="Asset category such as auto, laptop, desktop, vm, or server")
    parser.add_argument("--assigned-to-email", default=os.getenv("ITMS_ASSIGNED_TO_EMAIL", ""), help="Employee email to link the asset to")
    parser.add_argument("--assigned-to-name", default=os.getenv("ITMS_ASSIGNED_TO_NAME", ""), help="Employee name for enrollment review")
    parser.add_argument("--employee-code", default=os.getenv("ITMS_EMPLOYEE_CODE", ""), help="Employee ID for enrollment review")
    parser.add_argument("--department-name", default=os.getenv("ITMS_DEPARTMENT_NAME", ""), help="Department name for enrollment review")
    parser.add_argument("--entity-id", default=os.getenv("ITMS_ENTITY_ID", ""), help="Optional entity UUID")
    parser.add_argument("--dept-id", default=os.getenv("ITMS_DEPT_ID", ""), help="Optional department UUID")
    parser.add_argument("--location-id", default=os.getenv("ITMS_LOCATION_ID", ""), help="Optional location UUID")
    parser.add_argument("--purchase-date", default=os.getenv("ITMS_PURCHASE_DATE", ""), help="Optional purchase date in YYYY-MM-DD")
    parser.add_argument("--warranty-until", default=os.getenv("ITMS_WARRANTY_UNTIL", ""), help="Optional warranty date in YYYY-MM-DD")
    parser.add_argument("--status", default=os.getenv("ITMS_ASSET_STATUS", "in_use"), help="Asset status to report")
    parser.add_argument("--condition", default=os.getenv("ITMS_ASSET_CONDITION", "good"), help="Asset condition to report")
    parser.add_argument("--source-fingerprint", default=os.getenv("ITMS_SOURCE_FINGERPRINT", ""), help="Stable device fingerprint. Defaults to machine-id or hardware UUID")
    parser.add_argument("--salt-minion-id", default=os.getenv("ITMS_SALT_MINION_ID", ""), help="Optional Salt minion ID override")
    parser.add_argument("--wazuh-agent-id", default=os.getenv("ITMS_WAZUH_AGENT_ID", ""), help="Optional Wazuh agent ID")
    parser.add_argument("--notes", default=os.getenv("ITMS_ASSET_NOTES", "Imported from system collector"), help="Freeform asset notes")
    parser.add_argument("--software-limit", type=int, default=int(os.getenv("ITMS_SOFTWARE_LIMIT", "5000")), help="Inventory bound (max 10000); exceeding it explicitly marks the scan partial")
    parser.add_argument("--no-software-scan", action="store_true", help="Skip installed software collection")
    parser.add_argument("--service-limit", type=int, default=5000, help="Service inventory bound (max 10000); truncation is partial")
    parser.add_argument("--include-clamav-report", action="store_true", default=env_flag("ITMS_INCLUDE_CLAMAV_REPORT"), help="Run a ClamAV scan and include the report in the payload")
    parser.add_argument("--clamav-scan-path", action="append", dest="clamav_scan_paths", default=env_list("ITMS_CLAMAV_SCAN_PATHS"), help="Path to include in the ClamAV scan. Can be passed multiple times")
    parser.add_argument("--clamav-timeout", type=int, default=int(os.getenv("ITMS_CLAMAV_TIMEOUT", "3600")), help="Maximum ClamAV scan runtime in seconds")
    parser.add_argument("--include-openscap-report", action="store_true", default=env_flag("ITMS_INCLUDE_OPENSCAP_REPORT"), help="Attach the latest OpenSCAP result summary from the configured results directory")
    parser.add_argument("--openscap-results-dir", default=os.getenv("ITMS_OPENSCAP_RESULTS_DIR", "/var/lib/itms/openscap"), help="Directory containing OpenSCAP result files")
    parser.add_argument("--include-cve-report", action="store_true", default=env_flag("ITMS_INCLUDE_CVE_REPORT"), help="Run a Trivy root filesystem vulnerability scan and include the report")
    parser.add_argument("--cve-scan-target", default=os.getenv("ITMS_CVE_SCAN_TARGET", "/"), help="Root filesystem path for Trivy to scan")
    parser.add_argument("--cve-timeout", type=int, default=int(os.getenv("ITMS_CVE_TIMEOUT", "3600")), help="Maximum Trivy scan runtime in seconds")
    parser.add_argument("--use-hardinfo-fallback", action="store_true", default=env_flag("ITMS_USE_HARDINFO_FALLBACK"), help="Use hardinfo report parsing as a fallback for display details when available")
    parser.add_argument("--print-only", action="store_true", help="Print JSON payload instead of sending it")
    parser.add_argument("--heartbeat-only", action="store_true", help="Send a lightweight contact signal without scanning inventory")
    parser.add_argument("--inventory-only", action="store_true", help="Collect inventory without running or attaching security scans")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")
    return parser.parse_args()


def main():
    # Read known metadata as data. Never source or evaluate shell configuration.
    for key in ("SERVER_URL", "ASSET_TAG", "ASSET_NAME", "ASSET_CATEGORY", "ASSET_NOTES",
                "ASSIGNED_TO_EMAIL", "ASSIGNED_TO_NAME", "EMPLOYEE_CODE", "DEPARTMENT_NAME",
                "ENTITY_ID", "DEPT_ID", "LOCATION_ID", "USE_HARDINFO_FALLBACK"):
        name = "ITMS_" + key
        if name not in os.environ:
            value = env_file_value(name)
            if value:
                try:
                    os.environ[name] = " ".join(shlex.split(value))
                except ValueError:
                    pass
    args = parse_args()
    token = ""
    if args.token_file:
        token = read_value_file(args.token_file)
    elif args.prompt_token:
        token = read_secret_prompt("Inventory ingest token")
    else:
        token = (os.getenv("ITMS_INGEST_TOKEN", "") or "").strip()
        if not token:
            token = env_file_value("ITMS_INGEST_TOKEN")

    if args.heartbeat_only:
        return send_heartbeat(args, token)

    if args.inventory_only:
        args.include_clamav_report = False
        args.include_cve_report = False
        args.include_openscap_report = False

    payload = build_asset_payload(args)

    if args.print_only:
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    if not token:
        sys.stderr.write("Missing ingest token. Set ITMS_INGEST_TOKEN, use --token-file, use --prompt-token, or rely on /etc/itms-agent.env.\n")
        return 1

    endpoint = normalize_endpoint(args.server_url)
    try:
        status_code, response_body = post_payload(endpoint, token, payload, args.timeout)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="ignore")
        sys.stderr.write(f"Inventory push failed with HTTP {error.code}: {body}\n")
        return 1
    except urllib.error.URLError as error:
        sys.stderr.write(f"Inventory push failed: {error}\n")
        return 1

    sys.stdout.write(f"Inventory push succeeded with HTTP {status_code}.\n")
    if response_body:
        try:
            parsed = json.loads(response_body)
            json.dump(parsed, sys.stdout, indent=2)
            sys.stdout.write("\n")
        except json.JSONDecodeError:
            sys.stdout.write(response_body + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())