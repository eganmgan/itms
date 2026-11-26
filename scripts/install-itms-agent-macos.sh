#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="/Library/Application Support/ITMS"
ENV_FILE="/etc/itms-agent.env"
COLLECTOR_TARGET="$INSTALL_DIR/push-system-inventory.py"
LAUNCH_DAEMON="/Library/LaunchDaemons/com.itms.inventory-refresh.plist"

SERVER_URL=""
INGEST_TOKEN=""
ENROLLMENT_TOKEN=""
PROMPT_INGEST_TOKEN=0
ASSIGNED_TO_EMAIL=""
ASSIGNED_TO_NAME=""
EMPLOYEE_CODE=""
DEPARTMENT_NAME=""
ASSET_TAG=""
ASSET_NAME=""
CATEGORY="auto"
NOTES="Installed by ITMS macOS bootstrap"
SALT_MASTER=""
WAZUH_MANAGER=""
WAZUH_GROUP="default"
SSH_TARGET_USER=""
AUTHORIZED_KEY=""
REFRESH_HOURS="6"
REQUIRE_SALT="false"
INSTALL_CVE_SCANNER="false"
COLLECTOR_URL=""
WAZUH_VERSION="${ITMS_WAZUH_VERSION:-4.14.1}"
WAZUH_PACKAGE_URL="${ITMS_WAZUH_PACKAGE_URL:-}"

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://itms.example.com/installers/install-itms-agent-macos.sh | sudo bash -s -- --server-url https://itms.example.com --prompt-token [options]

Required:
  --server-url URL         ITMS backend base URL
  --enrollment-token TOKEN Exchange a short-lived enrollment token automatically
  --prompt-token           Prompt for INVENTORY_INGEST_TOKEN without echo

Optional:
  --assigned-to-email MAIL Asset owner email
  --assigned-to-name NAME  Employee name
  --employee-code ID       Employee ID
  --department-name NAME   Employee department
  --asset-tag TAG          Override the generated asset tag
  --name NAME              Override the endpoint name
  --category NAME          Asset category, default: auto
  --notes TEXT             Asset notes
  --salt-master HOST       Salt master hostname or IP
  --wazuh-manager HOST     Wazuh manager hostname or IP
  --wazuh-group NAME       Wazuh group, default: default
  --ssh-user USER          Public-key-only Remote Login account
  --authorized-key KEY     OpenSSH public key for --ssh-user
  --refresh-hours N        Inventory interval, default: 6
  --require-salt           Fail if Salt cannot be installed
  --install-cve-scanner    Install Trivy and include CVE reports
  --collector-url URL      Override the Python collector URL
  --wazuh-package-url URL  Override the Wazuh macOS package URL
EOF
}

log() {
  printf '[itms-macos-bootstrap] %s\n' "$*"
}

exchange_enrollment_token() {
  local enrollment_url
  enrollment_url="${SERVER_URL%/}/api/inventory-sync/enroll"
  INGEST_TOKEN="$(curl -fsS -X POST -H "Authorization: Bearer $ENROLLMENT_TOKEN" "$enrollment_url")"
  ENROLLMENT_TOKEN=""
}

require_macos_root() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'This installer supports macOS only.\n' >&2
    exit 1
  fi
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    printf 'This installer must run as root. Use sudo.\n' >&2
    exit 1
  fi
}

read_secret_prompt() {
  local value
  if [[ ! -r /dev/tty ]]; then
    printf 'Cannot securely prompt for the inventory token without a terminal.\n' >&2
    exit 1
  fi
  read -r -s -p 'Inventory ingest token: ' value < /dev/tty
  printf '\n' >&2
  printf '%s' "$value"
}

shell_env_quote() {
  printf '%q' "$1"
}

console_user() {
  local user
  user="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
  if [[ -z "$user" || "$user" == "root" || "$user" == "loginwindow" ]]; then
    printf 'A signed-in macOS administrator is required to manage Homebrew packages.\n' >&2
    exit 1
  fi
  printf '%s' "$user"
}

brew_command() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    printf '/opt/homebrew/bin/brew'
  elif [[ -x /usr/local/bin/brew ]]; then
    printf '/usr/local/bin/brew'
  else
    printf 'Homebrew is required. Install it from https://brew.sh while signed in as an administrator, then rerun this command.\n' >&2
    exit 1
  fi
}

run_brew() {
  local user brew
  user="$(console_user)"
  brew="$(brew_command)"
  sudo -H -u "$user" "$brew" "$@"
}

install_brew_package() {
  local package_name="$1"
  if ! run_brew list --versions "$package_name" >/dev/null 2>&1; then
    run_brew install "$package_name"
  fi
}

configure_passwordless_ssh() {
  if [[ -z "$SSH_TARGET_USER" || -z "$AUTHORIZED_KEY" ]]; then
    return
  fi

  if ! id "$SSH_TARGET_USER" >/dev/null 2>&1; then
    local next_uid
    next_uid="$(dscl . -list /Users UniqueID | awk '$2 >= 500 && $2 < 60000 {if ($2 > max) max=$2} END {print max + 1}')"
    dscl . -create "/Users/$SSH_TARGET_USER"
    dscl . -create "/Users/$SSH_TARGET_USER" UserShell /bin/zsh
    dscl . -create "/Users/$SSH_TARGET_USER" RealName 'ITMS Remote Support'
    dscl . -create "/Users/$SSH_TARGET_USER" UniqueID "$next_uid"
    dscl . -create "/Users/$SSH_TARGET_USER" PrimaryGroupID 20
    dscl . -create "/Users/$SSH_TARGET_USER" NFSHomeDirectory "/Users/$SSH_TARGET_USER"
    dscl . -create "/Users/$SSH_TARGET_USER" Password '*'
    dscl . -create "/Users/$SSH_TARGET_USER" IsHidden 1
    createhomedir -c -u "$SSH_TARGET_USER" >/dev/null
  fi

  local home_dir ssh_dir authorized_keys
  home_dir="$(dscl . -read "/Users/$SSH_TARGET_USER" NFSHomeDirectory | awk '{print $2}')"
  ssh_dir="$home_dir/.ssh"
  authorized_keys="$ssh_dir/authorized_keys"
  install -d -m 0700 -o "$SSH_TARGET_USER" -g staff "$ssh_dir"
  touch "$authorized_keys"
  grep -Fqx "$AUTHORIZED_KEY" "$authorized_keys" || printf '%s\n' "$AUTHORIZED_KEY" >> "$authorized_keys"
  chown "$SSH_TARGET_USER":staff "$authorized_keys"
  chmod 0600 "$authorized_keys"
  dseditgroup -o edit -a "$SSH_TARGET_USER" -t user com.apple.access_ssh >/dev/null 2>&1 || true
  systemsetup -setremotelogin on >/dev/null 2>&1 || log 'Remote Login could not be enabled automatically. Enable it in System Settings > General > Sharing.'
}

install_salt_minion() {
  if command -v salt-minion >/dev/null 2>&1; then
    return
  fi
  install_brew_package salt
}

configure_salt_minion() {
  if [[ -z "$SALT_MASTER" ]] || ! command -v salt-minion >/dev/null 2>&1; then
    return
  fi
  local brew_prefix config_dir
  brew_prefix="$(run_brew --prefix)"
  config_dir="$brew_prefix/etc/salt/minion.d"
  install -d -m 0755 "$config_dir"
  printf 'master: %s\n' "$SALT_MASTER" > "$config_dir/itms.conf"
  run_brew services restart salt >/dev/null 2>&1 || run_brew services start salt >/dev/null 2>&1 || log 'Salt installed; start salt-minion with your managed service policy.'
}

install_wazuh_agent() {
  if [[ -d /Library/Ossec ]]; then
    return
  fi
  local architecture package_url package_file
  architecture="$(uname -m)"
  if [[ -n "$WAZUH_PACKAGE_URL" ]]; then
    package_url="$WAZUH_PACKAGE_URL"
  elif [[ "$architecture" == "arm64" ]]; then
    package_url="https://packages.wazuh.com/4.x/macos/wazuh-agent-${WAZUH_VERSION}-1.arm64.pkg"
  else
    package_url="https://packages.wazuh.com/4.x/macos/wazuh-agent-${WAZUH_VERSION}-1.intel64.pkg"
  fi
  package_file="$(mktemp -t itms-wazuh).pkg"
  curl -fsSL "$package_url" -o "$package_file"
  installer -pkg "$package_file" -target /
  rm -f "$package_file"
}

configure_wazuh_agent() {
  if [[ -z "$WAZUH_MANAGER" || ! -f /Library/Ossec/etc/ossec.conf ]]; then
    return
  fi
  python3 - /Library/Ossec/etc/ossec.conf "$WAZUH_MANAGER" "$WAZUH_GROUP" <<'PY'
import sys
import xml.etree.ElementTree as ET

path, manager, group = sys.argv[1:]
tree = ET.parse(path)
root = tree.getroot()
client = root.find("client")
if client is None:
    client = ET.SubElement(root, "client")
server = client.find("server")
if server is None:
    server = ET.SubElement(client, "server")
address = server.find("address")
if address is None:
    address = ET.SubElement(server, "address")
address.text = manager
if group:
    enrollment = client.find("enrollment")
    if enrollment is None:
        enrollment = ET.SubElement(client, "enrollment")
    groups = enrollment.find("groups")
    if groups is None:
        groups = ET.SubElement(enrollment, "groups")
    groups.text = group
tree.write(path, encoding="unicode")
PY
  /Library/Ossec/bin/wazuh-control restart >/dev/null 2>&1 || true
}

install_security_tools() {
  install_brew_package clamav
  if [[ "$INSTALL_CVE_SCANNER" == "true" ]]; then
    install_brew_package trivy
  fi
}

install_collector() {
  local collector_url
  collector_url="$COLLECTOR_URL"
  if [[ -z "$collector_url" ]]; then
    collector_url="${SERVER_URL%/}/installers/push-system-inventory.py"
  fi
  install -d -m 0755 "$INSTALL_DIR"
  curl -fsSL "$collector_url" -o "$COLLECTOR_TARGET"
  chmod 0755 "$COLLECTOR_TARGET"
}

write_env_file() {
  umask 077
  {
    printf 'ITMS_SERVER_URL=%s\n' "$(shell_env_quote "$SERVER_URL")"
    printf 'ITMS_INGEST_TOKEN=%s\n' "$(shell_env_quote "$INGEST_TOKEN")"
    printf 'ITMS_ASSET_CATEGORY=%s\n' "$(shell_env_quote "$CATEGORY")"
    printf 'ITMS_ASSIGNED_TO_EMAIL=%s\n' "$(shell_env_quote "$ASSIGNED_TO_EMAIL")"
    printf 'ITMS_ASSIGNED_TO_NAME=%s\n' "$(shell_env_quote "$ASSIGNED_TO_NAME")"
    printf 'ITMS_EMPLOYEE_CODE=%s\n' "$(shell_env_quote "$EMPLOYEE_CODE")"
    printf 'ITMS_DEPARTMENT_NAME=%s\n' "$(shell_env_quote "$DEPARTMENT_NAME")"
    printf 'ITMS_ASSET_TAG=%s\n' "$(shell_env_quote "$ASSET_TAG")"
    printf 'ITMS_ASSET_NAME=%s\n' "$(shell_env_quote "$ASSET_NAME")"
    printf 'ITMS_ASSET_NOTES=%s\n' "$(shell_env_quote "$NOTES")"
    printf 'ITMS_INCLUDE_CLAMAV_REPORT=true\n'
    printf 'ITMS_INCLUDE_OPENSCAP_REPORT=false\n'
    printf 'ITMS_INCLUDE_CVE_REPORT=%s\n' "$INSTALL_CVE_SCANNER"
  } > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

write_launch_daemon() {
  local interval
  interval="$((REFRESH_HOURS * 3600))"
  cat > "$LAUNCH_DAEMON" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.itms.inventory-refresh</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>set -a; source /etc/itms-agent.env; exec /usr/bin/python3 "$COLLECTOR_TARGET"</string>
  </array>
  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/var/log/itms-inventory.log</string>
  <key>StandardErrorPath</key><string>/var/log/itms-inventory-error.log</string>
</dict>
</plist>
EOF
  chmod 0644 "$LAUNCH_DAEMON"
  launchctl bootout system/com.itms.inventory-refresh >/dev/null 2>&1 || true
  launchctl bootstrap system "$LAUNCH_DAEMON"
  launchctl enable system/com.itms.inventory-refresh
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server-url) SERVER_URL="${2:-}"; shift 2 ;;
      --token) INGEST_TOKEN="${2:-}"; shift 2 ;;
      --enrollment-token) ENROLLMENT_TOKEN="${2:-}"; shift 2 ;;
      --prompt-token) PROMPT_INGEST_TOKEN=1; shift ;;
      --assigned-to-email) ASSIGNED_TO_EMAIL="${2:-}"; shift 2 ;;
      --assigned-to-name) ASSIGNED_TO_NAME="${2:-}"; shift 2 ;;
      --employee-code) EMPLOYEE_CODE="${2:-}"; shift 2 ;;
      --department-name) DEPARTMENT_NAME="${2:-}"; shift 2 ;;
      --asset-tag) ASSET_TAG="${2:-}"; shift 2 ;;
      --name) ASSET_NAME="${2:-}"; shift 2 ;;
      --category) CATEGORY="${2:-}"; shift 2 ;;
      --notes) NOTES="${2:-}"; shift 2 ;;
      --salt-master) SALT_MASTER="${2:-}"; shift 2 ;;
      --wazuh-manager) WAZUH_MANAGER="${2:-}"; shift 2 ;;
      --wazuh-group) WAZUH_GROUP="${2:-}"; shift 2 ;;
      --ssh-user) SSH_TARGET_USER="${2:-}"; shift 2 ;;
      --authorized-key) AUTHORIZED_KEY="${2:-}"; shift 2 ;;
      --refresh-hours) REFRESH_HOURS="${2:-}"; shift 2 ;;
      --require-salt) REQUIRE_SALT="true"; shift ;;
      --install-cve-scanner) INSTALL_CVE_SCANNER="true"; shift ;;
      --collector-url) COLLECTOR_URL="${2:-}"; shift 2 ;;
      --wazuh-package-url) WAZUH_PACKAGE_URL="${2:-}"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
  done

  if [[ -n "$ENROLLMENT_TOKEN" ]]; then
    exchange_enrollment_token
  elif [[ "$PROMPT_INGEST_TOKEN" -eq 1 ]]; then
    INGEST_TOKEN="$(read_secret_prompt)"
  fi
  if [[ -z "$SERVER_URL" || -z "$INGEST_TOKEN" ]]; then
    usage >&2
    exit 1
  fi
  if [[ ! "$REFRESH_HOURS" =~ ^[0-9]+$ || "$REFRESH_HOURS" -lt 1 ]]; then
    printf '%s\n' '--refresh-hours must be a positive integer.' >&2
    exit 1
  fi
}

main() {
  parse_args "$@"
  require_macos_root
  command -v python3 >/dev/null 2>&1 || { printf 'Python 3 is required. Install the Apple Command Line Tools and retry.\n' >&2; exit 1; }
  brew_command >/dev/null

  configure_passwordless_ssh
  if ! install_salt_minion; then
    if [[ "$REQUIRE_SALT" == "true" ]]; then
      printf 'Salt Minion installation failed and Salt is required.\n' >&2
      exit 1
    fi
    log 'Salt installation failed; continuing because it was not required.'
  fi
  configure_salt_minion
  install_wazuh_agent
  configure_wazuh_agent
  install_security_tools
  install_collector
  write_env_file
  write_launch_daemon

  log 'Pushing initial inventory snapshot'
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
  /usr/bin/python3 "$COLLECTOR_TARGET"
  log 'Bootstrap complete'
}

main "$@"