#!/usr/bin/env bash
# =============================================================================
# Static / offline verification for the Shapeoko Samba config.
# =============================================================================
# This runs on a developer host (incl. macOS) WITHOUT installing Samba. It:
#   1. Syntax-checks the shell scripts (bash -n) and lints them (shellcheck).
#   2. Renders smb.conf from the template exactly as install.sh would, and
#      asserts every security-relevant directive is present and correct.
#   3. Asserts install.sh encodes the fail-closed guarantees.
#   4. Runs `testparm -s` on the rendered config IF testparm is available
#      (skipped with a notice on hosts without Samba, e.g. macOS).
#
# NOT yet wired to CI — that is issue #14's job. Run manually:
#   bash deploy/samba/test-smb-config.sh
#
# Exit non-zero on the first failed assertion.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
TEMPLATE="${SCRIPT_DIR}/smb.conf"
INSTALL_SH="${SCRIPT_DIR}/install.sh"

PASS=0
FAIL=0
WORKDIR=""

cleanup() { [ -n "${WORKDIR}" ] && [ -d "${WORKDIR}" ] && rm -rf -- "${WORKDIR}"; }
trap cleanup EXIT

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '  \033[33mNOTE\033[0m %s\n' "$*"; }
sec()  { printf '\n=== %s ===\n' "$*"; }

# assert_grep <file> <extended-regex> <description>
assert_grep() {
  if grep -Eq -- "$2" "$1"; then ok "$3"; else bad "$3 (missing: /$2/ in $(basename "$1"))"; fi
}
# refute_grep <file> <extended-regex> <description>
refute_grep() {
  if grep -Eq -- "$2" "$1"; then bad "$3 (unexpected: /$2/ in $(basename "$1"))"; else ok "$3"; fi
}

# -----------------------------------------------------------------------------
sec "Files present"
for f in "${TEMPLATE}" "${INSTALL_SH}"; do
  if [ -f "${f}" ]; then ok "exists: $(basename "${f}")"; else bad "missing: ${f}"; fi
done

# -----------------------------------------------------------------------------
sec "Shell syntax (bash -n)"
for f in "${INSTALL_SH}" "${SCRIPT_DIR}/test-smb-config.sh"; do
  if bash -n "${f}"; then ok "bash -n: $(basename "${f}")"; else bad "bash -n: $(basename "${f}")"; fi
done

# -----------------------------------------------------------------------------
sec "Shell lint (shellcheck)"
if command -v shellcheck >/dev/null 2>&1; then
  for f in "${INSTALL_SH}" "${SCRIPT_DIR}/test-smb-config.sh"; do
    if shellcheck -x "${f}"; then ok "shellcheck: $(basename "${f}")"; else bad "shellcheck: $(basename "${f}")"; fi
  done
else
  note "shellcheck not installed — skipping lint (install: brew install shellcheck)."
fi

# -----------------------------------------------------------------------------
sec "install.sh fail-closed / hardening invariants"
assert_grep "${INSTALL_SH}" 'set -euo pipefail'                 "uses set -euo pipefail"
assert_grep "${INSTALL_SH}" 'mountpoint -q'                     "validates data partition is mounted"
assert_grep "${INSTALL_SH}" 'testparm -s'                       "validates config with testparm before install"
assert_grep "${INSTALL_SH}" 'smbpasswd'                         "provisions a Samba user"
assert_grep "${INSTALL_SH}" 'share DISABLED'                    "aborts with share disabled on user-creation failure"
assert_grep "${INSTALL_SH}" 'refusing to create a passwordless share' "refuses passwordless share in non-interactive mode"
# Only actual (non-comment) lines may not reference the system temp dirs.
if grep -v '^[[:space:]]*#' "${INSTALL_SH}" | grep -Eq -- '/tmp|/var/tmp'; then
  bad "never writes to /tmp or /var/tmp (found reference on a non-comment line)"
else
  ok "never writes to /tmp or /var/tmp"
fi
# Ordering guard: testparm/install must appear AFTER the mountpoint check.
mnt_line=$(grep -n 'mountpoint -q' "${INSTALL_SH}" | head -1 | cut -d: -f1)
inst_line=$(grep -n 'install -m 0644' "${INSTALL_SH}" | head -1 | cut -d: -f1)
if [ -n "${mnt_line}" ] && [ -n "${inst_line}" ] && [ "${mnt_line}" -lt "${inst_line}" ]; then
  ok "mount check precedes config install (fail-closed ordering)"
else
  bad "config install must come after the mount check"
fi
user_line=$(grep -n 'provision_samba_user$' "${INSTALL_SH}" | tail -1 | cut -d: -f1)
if [ -n "${user_line}" ] && [ -n "${inst_line}" ] && [ "${user_line}" -lt "${inst_line}" ]; then
  ok "samba user provisioning precedes config install (fail-closed ordering)"
else
  bad "samba user provisioning must come before config install"
fi

# -----------------------------------------------------------------------------
sec "Render smb.conf from template (as install.sh does)"
WORKDIR="$(mktemp -d "${TMPDIR:-.}/shapeoko-smbtest.XXXXXX")"
RENDERED="${WORKDIR}/smb.conf"
TEST_USER="shapeoko"
TEST_IFACES="eth0"
TEST_ALLOW="192.168.0.0/16 10.0.0.0/8 172.16.0.0/12"
sed \
  -e "s/__SMB_USER__/${TEST_USER}/g" \
  -e "s/__SMB_INTERFACES__/${TEST_IFACES}/g" \
  -e "s#__SMB_HOSTS_ALLOW__#${TEST_ALLOW}#g" \
  "${TEMPLATE}" > "${RENDERED}"
if grep -q '__SMB_' "${RENDERED}"; then bad "placeholders remain after render"; else ok "all placeholders substituted"; fi

# -----------------------------------------------------------------------------
sec "smb.conf security directives (AC coverage)"
# AC: SMB1 denied / SMB2 minimum
assert_grep "${RENDERED}" '^[[:space:]]*server min protocol[[:space:]]*=[[:space:]]*SMB2' "server min protocol >= SMB2 (SMB1 disabled)"
assert_grep "${RENDERED}" '^[[:space:]]*client min protocol[[:space:]]*=[[:space:]]*SMB2' "client min protocol >= SMB2"
# AC: guest / anonymous denied
assert_grep "${RENDERED}" '^[[:space:]]*map to guest[[:space:]]*=[[:space:]]*never'       "map to guest = never"
assert_grep "${RENDERED}" '^[[:space:]]*restrict anonymous[[:space:]]*=[[:space:]]*2'      "restrict anonymous = 2"
assert_grep "${RENDERED}" '^[[:space:]]*guest ok[[:space:]]*=[[:space:]]*no'               "share: guest ok = no"
# AC: LAN-only interface binding
assert_grep "${RENDERED}" '^[[:space:]]*bind interfaces only[[:space:]]*=[[:space:]]*yes'  "bind interfaces only = yes"
assert_grep "${RENDERED}" "^[[:space:]]*interfaces[[:space:]]*=.*${TEST_IFACES}"           "interfaces includes the LAN iface"
assert_grep "${RENDERED}" '^[[:space:]]*hosts deny[[:space:]]*=[[:space:]]*0\.0\.0\.0/0'   "hosts deny = 0.0.0.0/0 (default-deny)"
assert_grep "${RENDERED}" '^[[:space:]]*hosts allow[[:space:]]*=.*192\.168'                "hosts allow scoped to private LAN"
# AC: restrictive file modes
assert_grep "${RENDERED}" '^[[:space:]]*create mask[[:space:]]*=[[:space:]]*0640'          "create mask = 0640"
assert_grep "${RENDERED}" '^[[:space:]]*directory mask[[:space:]]*=[[:space:]]*0750'       "directory mask = 0750"
assert_grep "${RENDERED}" '^[[:space:]]*force create mode[[:space:]]*=[[:space:]]*0640'    "force create mode = 0640"
assert_grep "${RENDERED}" '^[[:space:]]*force directory mode[[:space:]]*=[[:space:]]*0750' "force directory mode = 0750"
# Share definition
assert_grep "${RENDERED}" '^\[shapeoko\]'                                                   "[shapeoko] share defined"
assert_grep "${RENDERED}" "^[[:space:]]*valid users[[:space:]]*=[[:space:]]*${TEST_USER}"   "valid users pinned to owner"
assert_grep "${RENDERED}" '^[[:space:]]*path[[:space:]]*=[[:space:]]*/srv/gcode'            "share path = /srv/gcode"
assert_grep "${RENDERED}" '^[[:space:]]*writable[[:space:]]*=[[:space:]]*yes'               "share is writable"
# Negative: no lingering guest-friendly directives
refute_grep "${RENDERED}" '^[[:space:]]*guest ok[[:space:]]*=[[:space:]]*yes'               "no 'guest ok = yes' anywhere"
refute_grep "${RENDERED}" '^[[:space:]]*(server|client) min protocol[[:space:]]*=[[:space:]]*NT1' "no SMB1/NT1 protocol"

# -----------------------------------------------------------------------------
sec "testparm validation (Pi/Samba only)"
if command -v testparm >/dev/null 2>&1; then
  if testparm -s "${RENDERED}" >/dev/null 2>"${WORKDIR}/tp.err"; then
    ok "testparm accepts rendered config"
  else
    bad "testparm rejected rendered config"; cat "${WORKDIR}/tp.err" >&2
  fi
else
  note "testparm not available on this host (expected on macOS) — Samba syntax is an OWNER verification step on the Pi."
fi

# -----------------------------------------------------------------------------
sec "Summary"
printf 'PASS=%d FAIL=%d\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
echo "All static checks passed."
