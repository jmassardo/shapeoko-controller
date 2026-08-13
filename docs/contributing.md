# Contributing

This document captures conventions that must survive across contributors and
automated agent hand-offs. For the architecture decisions themselves, see
[`docs/architecture.md`](architecture.md); for licensing rules, see
[`docs/licensing-policy.md`](licensing-policy.md).

## Changelog convention

Release history lives in [`CHANGELOG.md`](../CHANGELOG.md) at the repo root. It
follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

This project ships a **large number of very small pull requests** by design. To
keep release history coherent instead of fragmenting across dozens of tiny commit
titles, the changelog is written **as work merges**, in human-facing prose.

### The rule

**Every user-visible change gets exactly one changelog entry, written when its PR
merges.**

- One entry per **issue**, not per commit. An issue that took four commits is
  still one line, and it ends with the issue number in parentheses — `(#142)` or
  `(#118, #121, #124)`.
- Entries are phrased for the **person using the software**, not the person who
  wrote it. Lead with what changed for the user; do not name internal files,
  functions, or classes.
- **Internal-only changes get no entry.** Refactors, test-only changes, CI
  tweaks, and dependency bumps with no behavioral effect are deliberately left
  out — a changelog padded with noise is as useless as no changelog.
- Work that merges behind an off feature flag is **not** yet user-visible: hold
  its entry until the flag is turned on, then record it under the release that
  enables it.

### Where entries go

While no release has been cut, all entries live under a single `## [Unreleased]`
section. Use only the six Keep a Changelog categories, in this order, omitting any
that are empty:

`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

Call out breaking changes with a bold **BREAKING:** prefix and a one-line
migration hint. Always call out security fixes explicitly under `Security`.

### Who writes entries

- **Integrator** — adds entries under `## [Unreleased]` as each wave merges, as
  part of the integration commit.
- **Platform & Ops** — at deploy time, renames `## [Unreleased]` to the new
  version, chooses the version from the entries themselves, updates the compare
  links, and tags the release.
- **Tech Lead** — ensures each user-visible change carries a changelog-worthy
  summary out of its pipeline.

Do **not** cut a version number or add automated changelog generation from commit
messages — human-facing prose is the point.
