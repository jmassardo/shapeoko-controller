#!/usr/bin/env node
// check-no-gpl3-headers.mjs
//
// Fails (exit 1) if any git-tracked, non-allowlisted, text file in this
// repository carries a GPL-3.0 license header or a GPL-3.0-family SPDX license
// identifier. This protects the project's MIT licensing: importing GPL-3.0
// material (headers/identifiers) would force the whole project to GPL-3.0.
//
// Design notes:
//   * Zero npm dependencies. Runnable directly: `node tools/check-no-gpl3-headers.mjs`
//   * Scans git-tracked files only (`git ls-files`), skipping binary assets.
//   * Detects licensing CONSTRUCTS (SPDX identifiers, GPL-3.0 header
//     boilerplate) rather than any prose mention of the string, so that
//     research/policy prose discussing the restriction is not falsely flagged.
//   * The two files whose explicit job is to document this restriction may name
//     a GPL-3.0 SPDX identifier as an example of what is forbidden; they are
//     allowlisted (see ALLOWLIST). No other file may.
//
// The detection patterns below are intentionally written with escaped literals
// and assembled fragments so that THIS script never itself contains a literal
// forbidden token, and therefore never flags itself.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

// Files permitted to name a GPL-3.0 SPDX identifier / header text because their
// explicit purpose is to document the restriction. Paths are repo-relative,
// forward-slash, as emitted by `git ls-files`.
const ALLOWLIST = new Set([
  "docs/licensing-policy.md",
  "THIRD-PARTY-NOTICES.md",
]);

// Binary / non-text asset extensions to skip.
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "avi", "webm", "wav", "ogg",
  "so", "dylib", "dll", "exe", "bin", "wasm",
]);

// Build the family suffix ("-3.0" etc.) from fragments so the literal forbidden
// token never appears contiguously in this source file.
const V3 = "3" + "\\." + "0";               // matches the literal "3.0"
const SUFFIX = "(?:-only|-or-later)";       // SPDX-only suffixes
const GPL = "GPL";

// Rule 1: an SPDX license identifier line naming a GPL-3.0-family license.
const SPDX_GPL3 = new RegExp(
  "SPDX-License-Identifier:\\s*[^\\r\\n]*?" + GPL + "-" + V3 + SUFFIX + "?",
  "i",
);

// Rule 2: a GPL-3.0 SPDX identifier token with an SPDX-specific suffix. The
// "-only"/"-or-later" suffixes appear only in SPDX identifiers, so matching
// them anywhere is safe and does not catch ordinary prose.
const GPL3_SUFFIXED_TOKEN = new RegExp(
  "\\b" + GPL + "-" + V3 + SUFFIX + "\\b",
  "i",
);

// Rule 3: GPL version 3 license header boilerplate (the full license name in
// proximity to "version 3"). Distinct from a passing prose mention of "GPL-3".
const GPL3_HEADER = new RegExp(
  "GNU\\s+GENERAL\\s+PUBLIC\\s+LICENSE[\\s\\S]{0,400}?[Vv]ersion\\s+3\\b",
  "i",
);

const RULES = [
  { name: "GPL-3.0 SPDX identifier line", re: SPDX_GPL3 },
  { name: "GPL-3.0 SPDX suffixed identifier token", re: GPL3_SUFFIXED_TOKEN },
  { name: "GPL version 3 license header", re: GPL3_HEADER },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);
}

function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function looksBinary(buf) {
  // Treat a NUL byte in the first 8000 bytes as a binary signal.
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function main() {
  const findings = [];
  let scanned = 0;
  let skipped = 0;

  for (const rel of trackedFiles()) {
    if (ALLOWLIST.has(rel)) {
      skipped++;
      continue;
    }
    if (BINARY_EXT.has(extensionOf(rel))) {
      skipped++;
      continue;
    }

    const abs = resolve(repoRoot, rel);
    let buf;
    try {
      if (!statSync(abs).isFile()) {
        skipped++;
        continue;
      }
      buf = readFileSync(abs);
    } catch {
      // File tracked but not present in the working tree (e.g. deleted). Skip.
      skipped++;
      continue;
    }

    if (looksBinary(buf)) {
      skipped++;
      continue;
    }

    const text = buf.toString("utf8");
    for (const rule of RULES) {
      const m = rule.re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split(/\r\n|\r|\n/).length;
        findings.push({ rel, rule: rule.name, line });
      }
    }
    scanned++;
  }

  if (findings.length > 0) {
    console.error("GPL-3.0 header/SPDX check FAILED. Offending files:");
    for (const f of findings) {
      console.error(`  ${f.rel}:${f.line}  (${f.rule})`);
    }
    console.error(
      "\nThis project is MIT. GPL-3.0 headers/identifiers are not permitted " +
        "outside the documented policy/notice files. See docs/licensing-policy.md.",
    );
    process.exit(1);
  }

  console.log(
    `GPL-3.0 header/SPDX check passed. Scanned ${scanned} file(s), ` +
      `skipped ${skipped} (allowlisted/binary).`,
  );
  process.exit(0);
}

main();
