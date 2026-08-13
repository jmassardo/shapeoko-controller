# Samba `.nc` ingest share (LAN-only)

This document describes the Samba share the owner uses to push `.nc` g-code files
from a workstation onto the Raspberry Pi that runs the Shapeoko controller. It
covers the security posture, installation, credential rotation, and
troubleshooting, plus the checks that can **only** be verified on the Pi itself.

> **This share feeds a machine with a spinning cutter.** The files dropped here
> are the ones that will be run on the Shapeoko. The configuration is
> deliberately restrictive and **fails closed**: if anything is misconfigured,
> the share does not come up rather than coming up insecure.

Related files (all under this repo):

- `deploy/samba/smb.conf` — hardened Samba config **template**.
- `deploy/samba/install.sh` — fail-closed installer.
- `deploy/samba/test-smb-config.sh` — static/offline verification (developer host).

---

## Design decision OD-10: password-protected vs. trusted-LAN

**OD-10** is the owner's choice between:

1. **Password-protected (DEFAULT, shipped).** A single Samba account
   (`shapeoko` by default) authenticates every write. Guests and anonymous
   access are refused. This is what `smb.conf` and `install.sh` implement.
2. **Trusted-LAN / no password.** *Not supported by this configuration.* Even
   though the share is already bound to the LAN, the ingest path is not left
   open for unauthenticated writes. `install.sh` refuses to create a
   passwordless share and will abort rather than fall back to guest access.

If you genuinely operate a fully trusted, physically isolated network and want
option 2, that is a deliberate future change to this config — it is **not** the
default, and it is not something the installer will do implicitly.

---

## Security posture

The configuration enforces, in layers:

| Control | Directive(s) | Acceptance criterion |
| --- | --- | --- |
| SMB1/CIFS disabled | `server min protocol = SMB2_10`, `client min protocol = SMB2_10` | SMB1 access denied |
| No guests | `map to guest = never`, `guest ok = no`, `guest account = nobody` | Guest access denied |
| No anonymous | `restrict anonymous = 2` | Anonymous enumeration denied |
| LAN-only binding | `bind interfaces only = yes`, `interfaces = lo … <iface>` | Binds only to the LAN interface |
| Host allow/deny (defense in depth) | `hosts allow = 127.0.0.1 <LAN ranges>`, `hosts deny = 0.0.0.0/0` | Non-LAN hosts rejected at the app layer |
| Restrictive file modes | `create mask = 0640`, `directory mask = 0750`, `force create/directory mode` | Files/dirs created with restrictive modes |
| Single writer | `valid users`/`write list`/`force user = <owner>` | Only the owner account can write |
| Fail-closed install | mountpoint check, `smbpasswd` check, `testparm -s` gate | Missing mount / failed user creation aborts |

### 🚫 LAN-only: never expose this to the internet

- **Do not** port-forward TCP/UDP 137–139 or 445 on your router to the Pi.
- **Do not** place the Pi in a DMZ.
- **Do not** bind Samba to a WAN/VPN-exit interface.
- SMB over the public internet is a well-known ransomware/exfiltration vector.
  WAN/VPN transfer is explicitly **out of scope** for this share (see the issue's
  "Out of Scope"). If you need remote access, that is a separate, deliberate
  design with its own controls — not this share.

The interface Samba binds to is **configurable** (not a hardcoded IP). Set
`SMB_INTERFACES` to your Pi's LAN interface (usually `eth0` for wired, `wlan0`
for Wi-Fi). `bind interfaces only = yes` guarantees smbd/nmbd listen nowhere
else. `hosts allow`/`hosts deny` add an application-layer backstop pinned to
RFC1918 private ranges by default.

---

## Prerequisites

- Raspberry Pi OS (Debian bookworm), 64-bit.
- A **dedicated data partition mounted at the share path** (default `/srv/gcode`).
  This is required — see [Why the mount matters](#why-the-mount-matters).
- Run the installer as `root` (via `sudo`).

### Why the mount matters

The share path (`/srv/gcode`) is expected to live on a dedicated data
partition. If that partition is **not** mounted, the path would silently resolve
to a directory on the root filesystem, and g-code would accumulate on the SD
card's root fs — a "root fallback" that can fill the boot volume and is easy to
miss. `install.sh` therefore **refuses to configure the share unless the data
partition is mounted** (`mountpoint -q`). This is a hard, fail-closed check.

---

## Installation

From the repo on the Pi:

```bash
# Minimum: provide the owner's Samba password non-interactively, or omit
# SMB_PASSWORD to be prompted interactively by smbpasswd.
sudo SMB_INTERFACES="eth0" \
     SMB_PASSWORD='choose-a-strong-password' \
     bash deploy/samba/install.sh
```

Common overrides (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMB_USER` | `shapeoko` | Owner unix + Samba account name |
| `SMB_DATA_PATH` | `/srv/gcode` | Share directory |
| `SMB_INTERFACES` | `eth0` | LAN interface(s) / CIDR(s) to bind |
| `SMB_HOSTS_ALLOW` | `192.168.0.0/16 10.0.0.0/8 172.16.0.0/12` | App-layer allow list |
| `SMB_PASSWORD` | *(prompt)* | Owner Samba password; if unset & non-interactive, install **fails closed** |
| `SMB_REQUIRE_MOUNT` | `true` | Require the data partition to be mounted |
| `SMB_DATA_MOUNT` | `= SMB_DATA_PATH` | Mountpoint that must be mounted |
| `SMB_CONF_DEST` | `/etc/samba/smb.conf` | Installed config path |

The installer, in strict order (each step must succeed before the next):

1. Requires root; installs `samba` via `apt-get` if the tooling is missing.
2. **Fail closed:** verifies the data partition is mounted.
3. Creates a locked, no-login system user for the owner (idempotent).
4. Creates the share directory `0750`, owned by the owner (idempotent).
5. **Fail closed:** creates/confirms the Samba account with `smbpasswd`; aborts
   with the share **disabled** if this fails or no password is available.
6. Renders `smb.conf` from the template and substitutes the interface/user/hosts.
7. **Fail closed:** validates the rendered config with `testparm -s`; does not
   install it if validation fails.
8. Backs up any existing `/etc/samba/smb.conf`, installs the validated config,
   then enables and restarts `smbd`.

Because the config is only written and the service only (re)started **after**
every check passes, a failure never leaves a half-configured, enabled share.

The installer is **idempotent** — re-running it is safe. Re-running does **not**
change an existing Samba password (rotate deliberately; see below).

---

## Credential rotation

Rotate the owner's Samba password directly on the Pi:

```bash
sudo smbpasswd shapeoko        # prompts for the new password
```

To disable the account (revoke access without deleting it):

```bash
sudo smbpasswd -d shapeoko     # disable
sudo smbpasswd -e shapeoko     # re-enable
```

Recommended hygiene:

- Use a strong, unique password stored in your password manager.
- Rotate after sharing the workstation, after any suspected exposure, and on a
  periodic schedule.
- Samba passwords are independent of the unix login password (the unix account
  is locked / no-login on purpose).

---

## Connecting from a workstation

- **macOS (Finder):** `Cmd-K` → `smb://<pi-ip>/shapeoko` → authenticate as
  `shapeoko`.
- **Windows (Explorer):** `\\<pi-ip>\shapeoko` → authenticate as `shapeoko`.
- **Linux:** `smbclient //<pi-ip>/shapeoko -U shapeoko` or mount via `cifs-utils`.

Drop `.nc` files into the share; they land in `/srv/gcode` owned by the owner
account with `0640` file / `0750` directory modes. (Watching/indexing the
dropped files is issue #102/#103 — out of scope here.)

---

## Verification

### On any developer host (offline, incl. macOS)

Static checks — no Samba install required for the config assertions; `testparm`
is used if present:

```bash
bash deploy/samba/test-smb-config.sh
```

This runs `bash -n`, `shellcheck` (if installed), renders `smb.conf` and asserts
every security-relevant directive, verifies the installer's fail-closed
invariants and ordering, and runs `testparm -s` if Samba is available.

> This script is **not yet wired to CI** — wiring the repo's first CI test runner
> is issue #14. Until then, run it manually before committing changes here.

### Owner verification — ON THE PI ONLY

The following behaviors depend on a running Samba service and real hardware and
**cannot** be verified from the development host. Run these on the Pi after
installing:

1. **Authenticated write succeeds.** From the workstation, connect as the owner
   and copy a small `.nc` file; confirm it appears in `/srv/gcode` with `0640`
   perms:
   ```bash
   ls -l /srv/gcode
   ```
2. **Guest access is denied.** Attempt an anonymous/guest connection; it must be
   rejected:
   ```bash
   smbclient //localhost/shapeoko -N        # expect NT_STATUS_ACCESS_DENIED / logon failure
   ```
3. **SMB1 is denied.** Force the legacy dialect; it must be refused:
   ```bash
   smbclient //localhost/shapeoko -U shapeoko --option='client min protocol=NT1' -m NT1
   # expect protocol negotiation failure
   ```
4. **LAN-only binding.** Confirm smbd is not listening on a WAN interface:
   ```bash
   sudo ss -tlnp | grep -E ':(139|445)\b'   # should show only the LAN iface / loopback
   testparm -s /etc/samba/smb.conf | grep -E 'bind interfaces only|interfaces'
   ```
5. **Missing-mount fail-closed.** With the data partition unmounted, the
   installer must abort non-zero and must not enable the share:
   ```bash
   sudo umount /srv/gcode 2>/dev/null || true
   sudo SMB_INTERFACES=eth0 SMB_PASSWORD=x bash deploy/samba/install.sh; echo "exit=$?"
   # expect a non-zero exit and a "data partition ... is NOT mounted" error
   ```
6. **User-creation fail-closed.** Simulate a failed/omitted credential in a
   non-interactive run; the installer must abort with the share disabled:
   ```bash
   sudo SMB_INTERFACES=eth0 bash deploy/samba/install.sh </dev/null; echo "exit=$?"
   # expect non-zero: "refusing to create a passwordless share"
   ```

Each of these six is an **owner responsibility on the Pi** — they are listed
here rather than claimed as passing, because they were not run on hardware.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Install aborts: `data partition ... is NOT mounted` | Data partition not mounted at the share path | Mount it (check `/etc/fstab`), then re-run. Dev hosts only: `SMB_REQUIRE_MOUNT=false`. |
| Install aborts: `refusing to create a passwordless share` | No `SMB_PASSWORD` and no TTY | Provide `SMB_PASSWORD=...` or run interactively. |
| Install aborts: `testparm rejected the rendered config` | Bad override (e.g. malformed `SMB_INTERFACES`) | Check the printed testparm error; fix the variable and re-run. |
| Client: `NT_STATUS_ACCESS_DENIED` | Wrong user/password, or account disabled | `sudo smbpasswd shapeoko` to reset; `sudo smbpasswd -e shapeoko` to enable. |
| Client: protocol negotiation fails | Client forcing SMB1 | Use SMB2/SMB3 (modern OSes do by default). SMB1 is intentionally disabled. |
| Can't see the share from another subnet | LAN-only by design | Connect from the shop LAN. Do **not** widen `hosts allow` to public ranges or port-forward. |
| `smbd` won't restart after install | Config or environment error | `sudo journalctl -u smbd -e` and `sudo testparm -s /etc/samba/smb.conf`. |

To inspect the effective config and the provisioned Samba users:

```bash
sudo testparm -s /etc/samba/smb.conf
sudo pdbedit -L        # list Samba accounts
```
