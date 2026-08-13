#!/usr/bin/env bash
# =============================================================================
# Shapeoko controller — Samba share installer (fail-closed)
# =============================================================================
# Provisions the single LAN-only, password-protected "shapeoko" share used to
# push .nc files onto the Pi. Designed for Raspberry Pi OS (Debian bookworm) /
# Samba 4.x.
#
# Design contract:
#   * set -euo pipefail; idempotent; re-runnable.
#   * FAIL CLOSED. If the data partition is not mounted, or the Samba user
#     cannot be provisioned, or the rendered config does not validate, the
#     script aborts NON-ZERO and does NOT leave a half-configured share
#     enabled. The config is only written and the service only enabled AFTER
#     every precondition has succeeded.
#
# Because this is the ingest path for files that drive a machine with a
# spinning cutter, guest/anonymous write access is never an acceptable
# simplification and this script contains no fallback that would create one.
#
# Configuration via environment (all optional except where noted):
#   SMB_USER            Owner account name.            (default: shapeoko)
#   SMB_DATA_PATH       Share directory.               (default: /srv/gcode)
#   SMB_INTERFACES      LAN interface(s) to bind.      (default: eth0)
#   SMB_HOSTS_ALLOW     Application-layer allow list.  (default: RFC1918 ranges)
#   SMB_PASSWORD        Owner Samba password. If unset AND stdin is a TTY the
#                       script prompts interactively via smbpasswd. If unset
#                       and non-interactive, the script FAILS CLOSED.
#   SMB_REQUIRE_MOUNT   Require SMB_DATA_PATH (or SMB_DATA_MOUNT) to be a real
#                       mountpoint. "true"/"false".   (default: true)
#   SMB_DATA_MOUNT      Mountpoint that must be mounted. (default: SMB_DATA_PATH)
#   SMB_CONF_DEST       Installed config path.         (default: /etc/samba/smb.conf)
#   SMB_ASSUME_YES      Skip apt install prompt.       (default: false)
# =============================================================================
set -euo pipefail

# --- Resolve paths -----------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
TEMPLATE_SRC="${SMB_CONF_SRC:-${SCRIPT_DIR}/smb.conf}"

# --- Configuration defaults --------------------------------------------------
SMB_USER="${SMB_USER:-shapeoko}"
SMB_DATA_PATH="${SMB_DATA_PATH:-/srv/gcode}"
SMB_INTERFACES="${SMB_INTERFACES:-eth0}"
SMB_HOSTS_ALLOW="${SMB_HOSTS_ALLOW:-192.168.0.0/16 10.0.0.0/8 172.16.0.0/12}"
SMB_REQUIRE_MOUNT="${SMB_REQUIRE_MOUNT:-true}"
SMB_DATA_MOUNT="${SMB_DATA_MOUNT:-${SMB_DATA_PATH}}"
SMB_CONF_DEST="${SMB_CONF_DEST:-/etc/samba/smb.conf}"
SMB_ASSUME_YES="${SMB_ASSUME_YES:-false}"

WORKDIR=""

log()  { printf '[install.sh] %s\n' "$*" >&2; }
die()  { printf '[install.sh] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  # Never leave scratch material behind; never touch /tmp directly.
  if [ -n "${WORKDIR}" ] && [ -d "${WORKDIR}" ]; then
    rm -rf -- "${WORKDIR}"
  fi
}
trap cleanup EXIT

# --- 0. Must be root ---------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  die "must be run as root (try: sudo $0)"
fi

[ -f "${TEMPLATE_SRC}" ] || die "template not found: ${TEMPLATE_SRC}"

# --- 1. Ensure Samba tooling is present -------------------------------------
ensure_samba_tools() {
  if command -v testparm >/dev/null 2>&1 \
     && command -v smbpasswd >/dev/null 2>&1 \
     && command -v pdbedit  >/dev/null 2>&1; then
    return 0
  fi
  log "Samba tooling not found; installing samba via apt-get..."
  command -v apt-get >/dev/null 2>&1 || die "apt-get unavailable; install 'samba' manually and re-run"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  if [ "${SMB_ASSUME_YES}" = "true" ]; then
    apt-get install -y samba
  else
    apt-get install -y samba
  fi
  command -v testparm >/dev/null 2>&1 || die "samba install did not provide testparm"
}
ensure_samba_tools

# --- 2. FAIL CLOSED: data partition must be mounted --------------------------
# If the dedicated data partition is not mounted, SMB_DATA_PATH would resolve
# to a directory on the root filesystem. Writing g-code there silently is
# exactly the "root fallback" failure mode we must prevent.
if [ "${SMB_REQUIRE_MOUNT}" = "true" ]; then
  if ! mountpoint -q -- "${SMB_DATA_MOUNT}"; then
    die "data partition '${SMB_DATA_MOUNT}' is NOT mounted. Refusing to configure the share (would write to the root filesystem fallback). Mount the data partition and re-run, or set SMB_REQUIRE_MOUNT=false ONLY for a dev host you fully control."
  fi
  log "Verified data partition is mounted: ${SMB_DATA_MOUNT}"
else
  log "WARNING: SMB_REQUIRE_MOUNT=false — skipping mountpoint check (dev mode)."
fi

# --- 3. Owner unix account (idempotent) --------------------------------------
if id -u "${SMB_USER}" >/dev/null 2>&1; then
  log "Unix user '${SMB_USER}' already exists."
else
  log "Creating locked, no-login system user '${SMB_USER}'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SMB_USER}" \
    || die "failed to create unix user '${SMB_USER}'"
  passwd -l "${SMB_USER}" >/dev/null 2>&1 || true   # no unix password login
fi

# --- 4. Share directory with restrictive ownership/mode (idempotent) ---------
log "Ensuring share directory ${SMB_DATA_PATH} (0750, ${SMB_USER})..."
mkdir -p -- "${SMB_DATA_PATH}" || die "failed to create ${SMB_DATA_PATH}"
chown "${SMB_USER}:${SMB_USER}" "${SMB_DATA_PATH}" || die "failed to chown ${SMB_DATA_PATH}"
chmod 0750 "${SMB_DATA_PATH}" || die "failed to chmod ${SMB_DATA_PATH}"

# --- 5. FAIL CLOSED: provision the Samba account -----------------------------
# If we cannot create/confirm the Samba user, we abort BEFORE installing the
# config, so no share is ever enabled without an authenticating account.
provision_samba_user() {
  if pdbedit -L 2>/dev/null | cut -d: -f1 | grep -qx "${SMB_USER}"; then
    log "Samba account '${SMB_USER}' already exists; leaving password unchanged."
    return 0
  fi

  if [ -n "${SMB_PASSWORD:-}" ]; then
    log "Creating Samba account '${SMB_USER}' from SMB_PASSWORD..."
    printf '%s\n%s\n' "${SMB_PASSWORD}" "${SMB_PASSWORD}" \
      | smbpasswd -s -a "${SMB_USER}" \
      || die "smbpasswd failed to create Samba account '${SMB_USER}' — aborting with share DISABLED"
  elif [ -t 0 ]; then
    log "Creating Samba account '${SMB_USER}' interactively (enter a password)..."
    smbpasswd -a "${SMB_USER}" \
      || die "smbpasswd failed to create Samba account '${SMB_USER}' — aborting with share DISABLED"
  else
    die "no SMB_PASSWORD provided and no TTY to prompt on; refusing to create a passwordless share. Set SMB_PASSWORD and re-run."
  fi

  # Confirm it actually landed.
  pdbedit -L 2>/dev/null | cut -d: -f1 | grep -qx "${SMB_USER}" \
    || die "Samba account '${SMB_USER}' not present after creation — aborting with share DISABLED"
}
provision_samba_user

# Ensure the account is enabled (idempotent, harmless if already enabled).
smbpasswd -e "${SMB_USER}" >/dev/null 2>&1 || true

# --- 6. Render config from template ------------------------------------------
# Scratch space in /run (tmpfs, root-only) — deliberately NOT /tmp or /var/tmp.
SCRATCH_BASE="/run"
[ -d "${SCRATCH_BASE}" ] && [ -w "${SCRATCH_BASE}" ] || SCRATCH_BASE="${SCRIPT_DIR}"
WORKDIR="$(mktemp -d "${SCRATCH_BASE}/shapeoko-smb.XXXXXX")" || die "mktemp failed"
RENDERED="${WORKDIR}/smb.conf"

# Escape sed replacement metacharacters (&, \, and the / delimiter).
sed_escape() { printf '%s' "$1" | sed -e 's/[&/\\]/\\&/g'; }

sed \
  -e "s/__SMB_USER__/$(sed_escape "${SMB_USER}")/g" \
  -e "s/__SMB_INTERFACES__/$(sed_escape "${SMB_INTERFACES}")/g" \
  -e "s/__SMB_HOSTS_ALLOW__/$(sed_escape "${SMB_HOSTS_ALLOW}")/g" \
  "${TEMPLATE_SRC}" > "${RENDERED}" || die "failed to render config"

# Point the share at the configured data path if it differs from the default.
if [ "${SMB_DATA_PATH}" != "/srv/gcode" ]; then
  sed -i -e "s#path = /srv/gcode#path = $(sed_escape "${SMB_DATA_PATH}")#g" "${RENDERED}"
fi

# Fail if any placeholder survived rendering.
if grep -q '__SMB_' "${RENDERED}"; then
  die "unsubstituted placeholder(s) remain in rendered config"
fi

# --- 7. FAIL CLOSED: validate before installing ------------------------------
log "Validating rendered config with testparm -s..."
testparm -s "${RENDERED}" >/dev/null 2>"${WORKDIR}/testparm.err" \
  || { cat "${WORKDIR}/testparm.err" >&2; die "testparm rejected the rendered config — NOT installing"; }

# --- 8. Install config (backup existing), then enable service ----------------
if [ -f "${SMB_CONF_DEST}" ]; then
  BACKUP="${SMB_CONF_DEST}.bak.$(date +%Y%m%d%H%M%S)"
  cp -a -- "${SMB_CONF_DEST}" "${BACKUP}"
  log "Backed up existing config to ${BACKUP}"
fi
install -m 0644 -- "${RENDERED}" "${SMB_CONF_DEST}" || die "failed to install ${SMB_CONF_DEST}"
log "Installed validated config to ${SMB_CONF_DEST}"

# --- 9. Restart & enable services --------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  log "Enabling and restarting smbd..."
  systemctl enable smbd  >/dev/null 2>&1 || true
  systemctl restart smbd || die "smbd failed to restart with the new config"
  # nmbd is optional (name resolution); do not hard-fail on it.
  systemctl restart nmbd >/dev/null 2>&1 || log "note: nmbd not restarted (optional)."
else
  log "systemctl not found; restart smbd manually to apply the new config."
fi

log "Done. Share 'shapeoko' -> ${SMB_DATA_PATH} for user '${SMB_USER}', LAN-only."
