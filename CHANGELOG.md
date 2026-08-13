# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The project is now released under the MIT License, with a binding contributor
  licensing policy that forbids importing GPL-3.0 (copyleft) source and documents
  the attribution rules for third-party material. (#11)
- LAN-only, password-protected Samba share for transferring `.nc` g-code files to
  the controller, hardened to refuse SMB1 and guest/anonymous access. (#101)
- Canonical machine-readable panel specification and JSON Schema for the Shapeoko
  Pro XXL operator panel, establishing a single source of truth for the physical
  control layout. (#116)
- TypeScript monorepo scaffold with npm workspaces for `@shapeoko/protocol`,
  `@shapeoko/sender-core`, and `@shapeoko/ui`, including shared ESLint 9 flat
  config, Prettier, Vitest, and a common `tsconfig.base.json`. (#12)
- `docs/architecture.md` recording the locked architecture decisions, with a
  pointer from the README. (#15)
- Panel firmware scaffold under `firmware/panel/` built with PlatformIO, targeting
  ESP32 with a host-side unit test environment. (#53)
- Shared `@shapeoko/protocol` package defining the machine state, settings, panel,
  and API contract types, plus work-coordinate-system types (`WcsId`, the
  `G54`–`G59` P-word mapping, `$G` parser state, and `$#` coordinate offsets). (#13)

[Unreleased]: https://github.com/jmassardo/shapeoko-controller/compare/eacdb7d...HEAD
