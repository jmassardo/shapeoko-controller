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
- Typed serial transport in `@shapeoko/sender-core` for talking to the controller
  over USB, covering the connect/disconnect lifecycle, line-oriented framing, and
  error propagation, with an injectable in-memory fake so the sender can be
  exercised end to end without a machine attached. (#22)
- Design token layer in `@shapeoko/ui` defining the color, typography, and spacing
  scales for the shop-floor interface, with automated gates that hold every
  foreground/background pairing to its WCAG contrast minimum and every interactive
  control to a glove-friendly touch-target size. (#40)
- Framed serial protocol between the controller and the ESP32 operator panel, using
  CRC-16 integrity checks and sequence numbers so corrupted, truncated, or
  out-of-order frames on the wire are detected and discarded instead of acted
  on. (#54)
- The operator panel mockup at `docs/hardware/panel-mockup.svg` is now generated
  from the canonical panel specification rather than hand-drawn, and CI
  regenerates it on every run and fails on any difference, so the published
  drawing can no longer drift from the spec it illustrates. (#117)

[Unreleased]: https://github.com/jmassardo/shapeoko-controller/compare/eacdb7d...HEAD
