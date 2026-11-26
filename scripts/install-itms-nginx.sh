#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
FRONTEND_DIST_DIR="$FRONTEND_DIR/dist"
HTTPS_TEMPLATE_PATH="$REPO_ROOT/deploy/nginx/itms.conf"
HTTP_TEMPLATE_PATH="$REPO_ROOT/deploy/nginx/itms-http.conf"
INSTALLER_SOURCE_DIR="$REPO_ROOT/scripts"

SITE_NAME="${SITE_NAME:-itms}"
SERVER_NAME="${SERVER_NAME:-}"
BACKEND_UPSTREAM="${BACKEND_UPSTREAM:-127.0.0.1:3001}"
WWW_ROOT="${WWW_ROOT:-/var/www/itms}"
INSTALLERS_ROOT="${INSTALLERS_ROOT:-$WWW_ROOT/installers}"
SSL_DIR="${SSL_DIR:-/etc/nginx/ssl}"
FRONTEND_DEV_PREVIEW="${FRONTEND_DEV_PREVIEW:-false}"
AVAILABLE_PATH="/etc/nginx/sites-available/${SITE_NAME}"
ENABLED_PATH="/etc/nginx/sites-enabled/${SITE_NAME}"
BUILD_USER="${SUDO_USER:-${USER:-}}"
BUILD_GROUP=""
DRY_RUN=0
HTTP_ONLY=0

usage() {
	cat <<'EOF'
Usage:
	install-itms-nginx.sh [server-name] [--dry-run]
	install-itms-nginx.sh [--dry-run] [server-name]

Options:
	--dry-run   Print the actions that would be taken without changing the host
	--http-only Configure nginx for HTTP only (no SSL cert/key required)
	--help      Show this message
EOF
}

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

run_privileged() {
	if [[ "$DRY_RUN" -eq 1 ]]; then
		printf '[dry-run]'
		printf ' %q' "$@"
		printf '\n'
		return 0
	fi

	if [[ "$EUID" -eq 0 ]]; then
		"$@"
	else
		sudo "$@"
	fi
}

run_as_build_user() {
	if [[ -z "$BUILD_USER" ]]; then
		echo "Unable to determine the non-root user for the frontend build." >&2
		exit 1
	fi

	if [[ "$DRY_RUN" -eq 1 ]]; then
		printf '[dry-run]'
		if [[ "$EUID" -eq 0 && -n "${SUDO_USER:-}" ]]; then
			printf ' %q' runuser -u "$BUILD_USER" -- "$@"
		else
			printf ' %q' "$@"
		fi
		printf '\n'
		return 0
	fi

	if [[ "$EUID" -eq 0 && -n "${SUDO_USER:-}" ]]; then
		runuser -u "$BUILD_USER" -- "$@"
	else
		"$@"
	fi
}

resolve_build_identity() {
	if [[ -z "$BUILD_USER" ]]; then
		echo "Unable to determine the non-root user for the frontend build." >&2
		exit 1
	fi

	BUILD_GROUP="$(id -gn "$BUILD_USER")"
}

escape_sed_replacement() {
	printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

parse_args() {
	local positional=()

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--dry-run)
				DRY_RUN=1
				shift
				;;
			--http-only)
				HTTP_ONLY=1
				shift
				;;
			--help|-h)
				usage
				exit 0
				;;
			--*)
				echo "Unknown argument: $1" >&2
				usage >&2
				exit 1
				;;
			*)
				positional+=("$1")
				shift
				;;
		esac
		done

	if [[ ${#positional[@]} -gt 1 ]]; then
		echo "Expected at most one positional server name." >&2
		usage >&2
		exit 1
	fi

	if [[ ${#positional[@]} -eq 1 && -z "${SERVER_NAME:-}" ]]; then
		SERVER_NAME="${positional[0]}"
	fi

	if [[ -z "$SERVER_NAME" ]]; then
		SERVER_NAME="YOUR_SERVER_IP"
	fi
}

require_command npm
require_command node
require_command sed
require_command mktemp
require_command id
if [[ "$EUID" -eq 0 && -n "${SUDO_USER:-}" ]]; then
	require_command runuser
fi

resolve_build_identity
parse_args "$@"

if [[ "$DRY_RUN" -eq 1 ]]; then
	echo "Running install-itms-nginx.sh in dry-run mode. No files or services will be changed."
fi

ensure_frontend_dependencies() {
	if [[ -d "$FRONTEND_DIR/node_modules" ]]; then
		return 0
	fi

	echo "Frontend dependencies are missing. Installing them in $FRONTEND_DIR..."
	cd "$FRONTEND_DIR"
	run_as_build_user npm install
	cd "$REPO_ROOT"
}

ensure_ssl_certificates() {
	local cert_path="${SSL_CERT_PATH:-$SSL_DIR/${SERVER_NAME}.crt}"
	local key_path="${SSL_KEY_PATH:-$SSL_DIR/${SERVER_NAME}.key}"

	if run_privileged test -f "$cert_path" && run_privileged test -f "$key_path"; then
		return 0
	fi

	echo "SSL certificate pair not found for $SERVER_NAME. Generating self-signed certificate..."
	run_privileged mkdir -p "$SSL_DIR"
	run_privileged openssl req -x509 -nodes -newkey rsa:2048 -sha256 \
		-keyout "$key_path" \
		-out "$cert_path" \
		-days 365 \
		-subj "/CN=${SERVER_NAME}"
	run_privileged chmod 600 "$key_path"
	run_privileged chmod 644 "$cert_path"
	echo "Generated certificate: $cert_path"
}

resolve_template_path() {
	if [[ "$HTTP_ONLY" -eq 1 ]]; then
		printf '%s' "$HTTP_TEMPLATE_PATH"
		return 0
	fi
	printf '%s' "$HTTPS_TEMPLATE_PATH"
}

missing_packages=()
if ! command -v nginx >/dev/null 2>&1; then
	missing_packages+=(nginx)
fi
if ! command -v rsync >/dev/null 2>&1; then
	missing_packages+=(rsync)
fi
if ! command -v openssl >/dev/null 2>&1; then
	missing_packages+=(openssl)
fi

if [[ ${#missing_packages[@]} -gt 0 ]]; then
	require_command apt-get
	echo "Installing required system packages: ${missing_packages[*]}"
	run_privileged apt-get update
	run_privileged apt-get install -y "${missing_packages[@]}"
fi

echo "Building frontend assets..."
ensure_frontend_dependencies
	if [[ -d "$FRONTEND_DIST_DIR" ]]; then
		run_privileged chown -R "$BUILD_USER:$BUILD_GROUP" "$FRONTEND_DIST_DIR"
	fi
echo "Frontend dev preview build flag: $FRONTEND_DEV_PREVIEW"
cd "$FRONTEND_DIR"
run_as_build_user env VITE_ENABLE_DEV_PREVIEW="$FRONTEND_DEV_PREVIEW" npm run build

if [[ ! -f "$FRONTEND_DIST_DIR/index.html" ]]; then
	echo "Expected frontend build output at $FRONTEND_DIST_DIR/index.html" >&2
	exit 1
fi

echo "Syncing frontend assets to $WWW_ROOT..."
	run_privileged mkdir -p "$WWW_ROOT"
	# Keep previously deployed hashed assets so stale browser sessions can finish loading.
	run_privileged rsync -a "$FRONTEND_DIST_DIR/" "$WWW_ROOT/"

echo "Syncing installer assets to $INSTALLERS_ROOT..."
	run_privileged mkdir -p "$INSTALLERS_ROOT"
	run_privileged rsync -a --delete \
		"$INSTALLER_SOURCE_DIR/install-itms-agent.sh" \
		"$INSTALLER_SOURCE_DIR/install-itms-agent-macos.sh" \
		"$INSTALLER_SOURCE_DIR/install-itms-agent.ps1" \
		"$INSTALLER_SOURCE_DIR/push-system-inventory.py" \
		"$INSTALLER_SOURCE_DIR/push-system-inventory.ps1" \
		"$INSTALLERS_ROOT/"

server_name_escaped="$(escape_sed_replacement "$SERVER_NAME")"
www_root_escaped="$(escape_sed_replacement "$WWW_ROOT")"
backend_upstream_escaped="$(escape_sed_replacement "$BACKEND_UPSTREAM")"
template_path="$(resolve_template_path)"

if [[ ! -f "$template_path" ]]; then
	echo "Missing nginx template: $template_path" >&2
	exit 1
fi

tmp_config="$(mktemp)"
trap 'rm -f "$tmp_config"' EXIT
sed \
	-e "s|__SERVER_NAME__|$server_name_escaped|g" \
	-e "s|__WWW_ROOT__|$www_root_escaped|g" \
	-e "s|__BACKEND_UPSTREAM__|$backend_upstream_escaped|g" \
	"$template_path" > "$tmp_config"

echo "Installing nginx site config for $SERVER_NAME..."
	run_privileged cp "$tmp_config" "$AVAILABLE_PATH"
	run_privileged ln -sfn "$AVAILABLE_PATH" "$ENABLED_PATH"
	run_privileged rm -f /etc/nginx/sites-enabled/default

if [[ "$HTTP_ONLY" -eq 0 ]]; then
	ensure_ssl_certificates
fi

echo "Validating nginx configuration..."
	run_privileged nginx -t

echo "Enabling and restarting nginx..."
	run_privileged systemctl enable nginx
	run_privileged systemctl restart nginx

echo
if [[ "$HTTP_ONLY" -eq 1 ]]; then
	echo "ITMS frontend is now served by nginx at http://$SERVER_NAME/login (HTTP only mode)"
else
	echo "ITMS frontend is now served by nginx at http://$SERVER_NAME/login"
fi
echo "nginx web root: $WWW_ROOT"
echo "backend upstream: $BACKEND_UPSTREAM"
