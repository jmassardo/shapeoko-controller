/**
 * Work-coordinate-system contract for the Shapeoko controller.
 *
 * Models the parts of the GRBL 1.1 protocol that concern WHICH fixture the
 * machine is working in and WHERE each fixture's origin sits: the `G54`–`G59`
 * work coordinate systems, the `$G` parser (modal) state that reports the
 * active one, and the `$#` coordinate-offsets response that reports all of
 * them. These are PURE data types and tiny pure helpers only — no serial I/O,
 * no runtime dependencies, and deliberately NO PARSING.
 *
 * Parsing the `$G` and `$#` text responses into these shapes belongs to the
 * sender-core GRBL codec (issue #24), exactly as parsing `?` status reports
 * does (issue #26). This file defines only the shape both sides agree on.
 *
 * WHY THIS LIVES IN THE CONTRACT: the driving workflow is a four-fixture
 * production pipeline — four parts held at four work coordinate systems, four
 * operations, parts advanced by hand between runs. Fixture identity therefore
 * crosses every boundary in the system (status caching, pre-flight, soft
 * limits, tool offsets, post-reset restore, and the touchscreen selector), so
 * it must be one shared type rather than six private ones.
 *
 * Note the reporting split, which is easy to get wrong: GRBL reports the
 * ACTIVE work coordinate system in the `$G` parser-state response, NOT in the
 * `?` real-time status report. The `?` report carries only the numeric `WCO:`
 * offset ({@link Position}), with no indication of which fixture it belongs
 * to. A consumer that needs to know "which fixture am I in?" must read `$G`.
 */

import type { Position } from './machine.js';

// ---------------------------------------------------------------------------
// Work coordinate systems (G54–G59).
// ---------------------------------------------------------------------------

/**
 * The six work coordinate systems of stock GRBL 1.1, in `P`-word order.
 *
 * Stock GRBL 1.1 supports exactly these six and no more. `G59.1`, `G59.2` and
 * `G59.3` are grblHAL / Mach / LinuxCNC extensions and are NOT available on the
 * closed-source Carbide 3D fork this project talks to — they are deliberately
 * excluded so that a consumer cannot express a fixture the machine cannot
 * select. Adding them later would be a contract change requiring explicit
 * coordination (issue #13).
 */
export const WCS_IDS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const;

/** A GRBL work coordinate system: one of `G54`–`G59`. */
export type WcsId = (typeof WCS_IDS)[number];

/** Type guard: is `value` one of the six supported work coordinate systems? */
export function isWcsId(value: unknown): value is WcsId {
  return typeof value === 'string' && (WCS_IDS as readonly string[]).includes(value);
}

/**
 * The `P` word that addresses a work coordinate system in `G10 L2 P<n>` and
 * `G10 L20 P<n>`: `P1`–`P6`. A closed numeric union so an off-by-one is a
 * compile error rather than a misdirected offset write.
 */
export type WcsPWord = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Mapping from work coordinate system to its `G10` `P` word.
 *
 * `P1=G54, P2=G55, P3=G56, P4=G57, P5=G58, P6=G59`.
 *
 * SAFETY: this mapping is load-bearing. Every fixture-zeroing (`G10 L20`) and
 * tool-offset correction (`G10 L2`) the sender issues names its target fixture
 * by `P` word, so an off-by-one here would silently write an offset into the
 * WRONG fixture — which, in the four-fixture pipeline, means the next job
 * plunges at coordinates that belong to a different part. It is typed as an
 * exact `Record<WcsId, WcsPWord>` so the compiler checks completeness, and it
 * is tested exhaustively in both directions.
 */
export const WCS_P_WORD: Readonly<Record<WcsId, WcsPWord>> = {
  G54: 1,
  G55: 2,
  G56: 3,
  G57: 4,
  G58: 5,
  G59: 6,
} as const;

/**
 * Convert a work coordinate system to its `G10 L2/L20 P<n>` word. Total pure
 * lookup over the closed {@link WcsId} set — it cannot fail.
 */
export function wcsIdToPWord(wcs: WcsId): WcsPWord {
  return WCS_P_WORD[wcs];
}

/**
 * Convert a `G10` `P` word back to its work coordinate system, or `undefined`
 * if `p` is outside `1`–`6`.
 *
 * Accepts an arbitrary `number` rather than a {@link WcsPWord} on purpose: the
 * inputs that need converting come from outside the type system (a parsed
 * g-code line, a stored job preference, a UI selection), so this is the
 * validating boundary. Callers MUST treat `undefined` as "not a fixture this
 * machine has" and refuse the operation — never coerce it to a default.
 */
export function pWordToWcsId(p: number): WcsId | undefined {
  return WCS_IDS[p - 1];
}

// ---------------------------------------------------------------------------
// Parser (modal) state — the `$G` response.
// ---------------------------------------------------------------------------

/** Motion mode modal group (`G0`/`G1`/`G2`/`G3`, the `G38.x` probes, `G80`). */
export type MotionMode = 'G0' | 'G1' | 'G2' | 'G3' | 'G38.2' | 'G38.3' | 'G38.4' | 'G38.5' | 'G80';

/** Plane-select modal group: `G17` XY, `G18` ZX, `G19` YZ. */
export type PlaneMode = 'G17' | 'G18' | 'G19';

/**
 * Units modal group: `G20` inches, `G21` millimetres.
 *
 * This project works in millimetres throughout ({@link Position} is always
 * metric). `G20` is modelled because the machine can be left in it by a
 * previous program and the sender must be able to observe — and restore — that
 * fact, not because we ever prefer it.
 */
export type UnitsMode = 'G20' | 'G21';

/** Distance modal group: `G90` absolute, `G91` incremental. */
export type DistanceMode = 'G90' | 'G91';

/**
 * Arc IJK distance modal group: `G91.1` incremental (GRBL's only supported
 * mode) — modelled as a union of one so the shape can widen without a breaking
 * change if the fork reports `G90.1`.
 */
export type ArcDistanceMode = 'G90.1' | 'G91.1';

/** Feed-rate modal group: `G93` inverse time, `G94` units per minute. */
export type FeedRateMode = 'G93' | 'G94';

/** Program-flow modal group: `M0` pause, `M1` optional stop, `M2`/`M30` end. */
export type ProgramMode = 'M0' | 'M1' | 'M2' | 'M30';

/** Spindle modal group: `M3` CW, `M4` CCW, `M5` stopped. */
export type SpindleMode = 'M3' | 'M4' | 'M5';

/** Coolant modal group: `M7` mist, `M8` flood, `M9` off. */
export type CoolantMode = 'M7' | 'M8' | 'M9';

/**
 * The parsed GRBL 1.1 parser-state response to `$G`, e.g.
 * `[GC:G0 G54 G17 G21 G90 G91.1 G94 M5 M9 T0 F0 S0]`.
 *
 * This is the ONLY place GRBL tells us which work coordinate system is active
 * — the `?` status report does not carry it. Two consumers need this whole
 * shape rather than just the fixture: issue #81 saves and restores modal state
 * around probe cycles (a probe move that runs under a leftover `G91` or `G20`
 * moves the wrong distance), and issue #151 restores the active work
 * coordinate system after a soft reset, because `0x18` returns the parser to
 * defaults and a four-fixture job resumed in the wrong fixture cuts the wrong
 * part.
 *
 * The modal-group fields are REQUIRED because GRBL always reports every modal
 * group in `$G` — a report missing one is a parse failure for the codec (#24)
 * to raise, not an absence for consumers to paper over. The trailing word
 * fields are optional per the notes on each.
 *
 * TYPES ONLY: parsing the `[GC:...]` line into this shape belongs to #24.
 *
 * UNVERIFIED (#16): the exact field set the Carbide 3D fork emits for `$G` has
 * not been captured from hardware — the fork is closed-source. This shape is
 * stock GRBL 1.1 (`grbl/report.c`, `report_gcode_modes`). The same hardware
 * session that captures the welcome string and `$I` build info for #16 must
 * also capture a raw `$G` response and confirm this field set; if the fork adds
 * or omits a modal group, this interface is the seam that changes. Consumers
 * must not assume a field the fork has not been shown to report.
 */
export interface ParserState {
  /** Motion modal group (`G0`, `G1`, `G2`, `G3`, `G38.x`, `G80`). */
  motion: MotionMode;
  /**
   * The ACTIVE work coordinate system. The reason this interface exists —
   * see #151 (restore after soft reset) and #87 (fixture selection).
   */
  wcs: WcsId;
  /** Plane-select modal group (`G17`/`G18`/`G19`). */
  plane: PlaneMode;
  /** Units modal group (`G20`/`G21`). */
  units: UnitsMode;
  /** Distance modal group (`G90`/`G91`). */
  distance: DistanceMode;
  /** Arc IJK distance modal group (`G91.1` on stock GRBL). */
  arcDistance: ArcDistanceMode;
  /** Feed-rate modal group (`G93`/`G94`). */
  feedRateMode: FeedRateMode;
  /** Spindle modal group (`M3`/`M4`/`M5`). */
  spindle: SpindleMode;
  /**
   * Coolant modal group. An array because `M7` (mist) and `M8` (flood) are
   * independently latchable and GRBL can report both at once; `M9` (off) is
   * reported alone. An empty array is not a valid `$G` state.
   */
  coolant: readonly CoolantMode[];
  /**
   * Program-flow modal group (`M0`/`M1`/`M2`/`M30`), when one is active. GRBL
   * omits this group entirely while a program is running normally, so its
   * absence means "no program-flow word latched".
   */
  program?: ProgramMode;
  /** `T` — the currently selected tool number. */
  tool: number;
  /** `F` — the current feed rate, in the reported {@link UnitsMode} per minute. */
  feed: number;
  /**
   * `S` — the current spindle speed (RPM). Optional because stock GRBL emits
   * the `S` word only when built with the variable-spindle option; its absence
   * means the firmware does not report spindle speed, not that speed is zero.
   */
  spindleSpeed?: number;
}

// ---------------------------------------------------------------------------
// Coordinate offsets — the `$#` response.
// ---------------------------------------------------------------------------

/**
 * The offset stored for one work coordinate system, or `null` when no offset
 * is known for that fixture.
 *
 * `null` is NOT the same as `{ x: 0, y: 0, z: 0 }` and the distinction is a
 * safety requirement, not a stylistic one. Issue #34 (soft-limit pre-flight,
 * as amended for the four-fixture pipeline) must REFUSE to run a job whose
 * fixture has never been zeroed, and it cannot make that decision if the type
 * collapses "unzeroed" into "zeroed at the machine origin" — which is itself a
 * legitimate, deliberately-chosen offset. Modelling absence as an explicit
 * `null` keeps the two distinguishable all the way to the refusal.
 *
 * Every {@link WcsId} key is REQUIRED in {@link CoordinateOffsets.wcs} even
 * though the value may be `null`, so that a consumer indexing by fixture always
 * gets a defined result and a mistyped key is a compile error rather than a
 * silent `undefined`.
 */
export type WcsOffset = Position | null;

/**
 * The parsed GRBL 1.1 coordinate-offsets response to `$#`, which reports the
 * six work coordinate system offsets followed by `G28`, `G30`, `G92` and
 * `TLO`.
 *
 * Both issue #85 (verifying a `G10 L20` fixture-zero actually landed) and issue
 * #96 (verifying a per-fixture tool-offset correction) re-read `$#` after
 * writing and compare against what they intended to write, so they need one
 * shared shape to compare against.
 *
 * TYPES ONLY: parsing the `[G54:...]`/`[TLO:...]` lines into this shape belongs
 * to #24. The `[PRB:...]` probe result is a DIFFERENT response with its own
 * existing shape and is deliberately not modelled here.
 */
export interface CoordinateOffsets {
  /**
   * The six `G54`–`G59` fixture offsets, keyed by {@link WcsId} so a consumer
   * can look one fixture up directly. `null` means "no offset known for this
   * fixture" — see {@link WcsOffset} for why that is distinct from zero.
   */
  wcs: Readonly<Record<WcsId, WcsOffset>>;
  /** `G28` — the stored predefined position 1. */
  g28: Position;
  /** `G30` — the stored predefined position 2. */
  g30: Position;
  /**
   * `G92` — the temporary coordinate offset, as REPORTED by GRBL.
   *
   * This project NEVER issues `G92`. It is banned project-wide in favour of
   * `G10 L20` / `G10 L2`, because `G92` is a volatile offset stacked on top of
   * the active fixture: it survives in surprising ways, is cleared by things
   * that do not look like it should clear it, and makes the reported work
   * position depend on invisible state. It is modelled here only because GRBL
   * reports it and a consumer verifying a `G10` write must be able to SEE a
   * non-zero `G92` left behind by some other tool and warn about it.
   */
  g92: Position;
  /**
   * `TLO` — the active tool length offset, a single scalar applied to Z.
   * GRBL reports one value, not a triple.
   */
  toolLengthOffset: number;
}

/**
 * True when `offsets` has a known offset for `wcs`. The predicate #34's
 * pre-flight refusal is written against — see {@link WcsOffset}.
 */
export function hasWcsOffset(offsets: CoordinateOffsets, wcs: WcsId): boolean {
  return offsets.wcs[wcs] !== null;
}

/**
 * Read one fixture's offset, or `null` when it is unknown. Pure lookup over
 * the closed {@link WcsId} set; the `null` is the caller's cue to refuse, not
 * to substitute a zero.
 */
export function getWcsOffset(offsets: CoordinateOffsets, wcs: WcsId): WcsOffset {
  return offsets.wcs[wcs];
}
