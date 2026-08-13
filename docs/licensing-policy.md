# Licensing Policy

This document is the **binding licensing policy** for the `shapeoko-controller`
project. It applies to every contributor, human or automated. If any other
document, comment, or convenience conflicts with this policy, this policy wins.

The project is licensed **MIT** (see [`LICENSE`](../LICENSE)). MIT is a
permissive license: anyone may use, modify, and redistribute this project's own
source, including in closed-source and commercial products, provided the MIT
copyright and permission notice is preserved.

Because the project is MIT, **no copyleft-licensed source may be imported into
this repository.** Copyleft licenses (most importantly the GNU GPL family) would
force this entire project to adopt the copyleft license, which is expressly not
what the project owner chose.

## Hard rules

1. **No GPL-3.0 code, ever.**
   No file in this repository may be copied, transliterated, translated,
   machine-converted, or line-by-line adapted from any GPL-3.0-licensed source.
   This includes gSender / Sienci Labs. You may **read** GPL-3.0 code to
   understand a design, a protocol, or a hardware behavior, and you may then
   write an original, clean implementation from that understanding. You may
   **not** reproduce its expression: copying its code, closely paraphrasing its
   structure statement-by-statement, or porting a function to TypeScript are all
   prohibited.

2. **No GPL-3.0 license headers or SPDX identifiers in project files.**
   No source, config, or documentation file that we author may carry a GPL-3.0
   license header or an SPDX identifier from the GPL-3.0 family
   (`GPL-3.0`, `GPL-3.0-only`, `GPL-3.0-or-later`). A CI-checkable scan,
   [`tools/check-no-gpl3-headers.mjs`](../tools/check-no-gpl3-headers.mjs),
   enforces this. The only files permitted to name those identifiers are the
   explanatory policy and notice files listed in
   [Allowlist for explanatory mentions](#allowlist-for-explanatory-mentions).

3. **No GPL-2.0 source copying either.**
   The `gnea/grbl` firmware is GPL-2.0. We treat it strictly as **protocol and
   behavior documentation**: we read it to learn the GRBL serial protocol,
   real-time command bytes, status report format, and probing semantics, and we
   implement our own client from the protocol. We do not copy GRBL source into
   this repository.

## Third-party sources and their permitted use

| Source | License | Permitted use in this repository |
| --- | --- | --- |
| `krudoy/shapeoko-gsender-macros` | MIT | **Usable with attribution.** May be consumed and adapted; preserve the upstream MIT copyright/permission notice and record it in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). |
| `gnea/grbl` | GPL-2.0 | **Protocol reference only.** Read to understand the GRBL protocol/behavior. No source copying, no header/SPDX import. |
| gSender / Sienci Labs | GPL-3.0 | **Design-understanding reference only.** Read for design/behavior comprehension. No copying, transliteration, or adaptation of its code. |

### Attribution requirements for MIT material

When we use MIT-licensed material (for example the `krudoy/shapeoko-gsender-macros`
pack), we must:

- Preserve the upstream copyright line and MIT permission notice.
- Add or update an entry in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)
  naming the project, its upstream URL, and its license.

## Allowlist for explanatory mentions

The no-GPL-3.0 scan flags GPL-3.0 SPDX identifiers and GPL-3.0 license headers
anywhere in the repository, **except** in the files whose explicit purpose is to
document these restrictions. Those files may legitimately name a GPL-3.0 SPDX
identifier such as `SPDX-License-Identifier: GPL-3.0-only` when explaining what
is forbidden. The allowlisted files are exactly:

- `docs/licensing-policy.md` (this file)
- `THIRD-PARTY-NOTICES.md`

No other file may name a GPL-3.0 SPDX identifier or carry a GPL-3.0 header.

## For maintainers wiring CI (issue #14)

Run the scan with no dependencies:

```sh
node tools/check-no-gpl3-headers.mjs
```

It exits `0` when clean and non-zero, printing the offending path(s), when a
disallowed GPL-3.0 header or SPDX identifier is found in a non-allowlisted file.
