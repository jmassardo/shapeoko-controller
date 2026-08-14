/**
 * Incremental GRBL line-protocol codec for `@shapeoko/sender-core` (issue #24).
 *
 * The serial transport ({@link SerialTransport}) hands us raw byte chunks whose
 * boundaries are arbitrary: a single `data` event may carry half a line, several
 * lines, or a line split across two events. This module turns that byte stream
 * into an ordered sequence of strongly-typed {@link GrblLineEvent}s, one per
 * complete CRLF- (or bare LF-) delimited GRBL line, while retaining any trailing
 * partial bytes until the next chunk completes them.
 *
 * Scope boundaries (deliberately narrow):
 *  - We recognise the line *shapes* GRBL 1.1 emits — `ok`, `error:N`, `ALARM:N`,
 *    `[...]` bracket messages, `$N=value` settings, the welcome banner, and the
 *    `<...>` status report — and map each to a discriminated-union variant.
 *  - We do **NOT** parse the contents of `<...>` status reports here; that is
 *    issue #25's job. We emit the raw report string verbatim
 *    ({@link GrblStatusReportRawEvent}) so #25 can consume it.
 *  - Streaming flow control (#31) and any UI presentation of alarms (#86) are
 *    likewise out of scope.
 *
 * Tolerance is the entire point of this codec: the Carbide 3D GRBL fork is
 * closed-source, so any line we do not positively recognise falls through to
 * `{ type: 'unknown', raw }` and the codec never throws. Callers can log unknown
 * lines without special-casing them.
 *
 * Domain facts and code tables below are derived from documented GRBL 1.1
 * behaviour and `docs/research/bitsetter-bitzero-protocol.md`. No GRBL/gSender
 * source was copied; descriptions are written from scratch.
 */

/** The `ok` acknowledgement GRBL sends after successfully accepting a line. */
export interface GrblOkEvent {
  readonly type: 'ok';
  /** The verbatim de-newlined line text (`ok`). */
  readonly raw: string;
}

/**
 * An `error:N` response. Only the numeric code is preserved here — mapping codes
 * to human text is intentionally left to higher layers, per the issue's "at
 * minimum error-code preservation" requirement. Malformed payloads (a
 * non-numeric code) never reach this variant; they become {@link GrblUnknownEvent}.
 */
export interface GrblErrorEvent {
  readonly type: 'error';
  /** The GRBL error code (e.g. `2` from `error:2`). Always a finite integer. */
  readonly code: number;
  /** The verbatim de-newlined line text (`error:2`). */
  readonly raw: string;
}

/**
 * An `ALARM:N` response. Unlike `error`, alarms carry a human-readable
 * description resolved from {@link GRBL_ALARM_DESCRIPTIONS} so that downstream
 * modules (and eventually the operator UI in #86) always have text to show —
 * even for codes outside the documented table, which get a generic fallback.
 */
export interface GrblAlarmEvent {
  readonly type: 'alarm';
  /** The GRBL alarm code (e.g. `5` from `ALARM:5`). Always a finite integer. */
  readonly code: number;
  /** Human-readable description of the alarm (never empty). */
  readonly text: string;
  /** The verbatim de-newlined line text (`ALARM:5`). */
  readonly raw: string;
}

/** A `[MSG:...]` informational message, e.g. `[MSG:'$H'|'$X' to unlock]`. */
export interface GrblMessageEvent {
  readonly type: 'message';
  /** The message body with the `[MSG:` prefix and trailing `]` stripped. */
  readonly text: string;
  /** The verbatim de-newlined line text including brackets. */
  readonly raw: string;
}

/**
 * A `[PRB:x,y,z:flag]` probe result. GRBL reports the machine position at the
 * moment of probe contact plus a success flag: numerically `1` (contact) or `0`
 * (no contact). We treat the numeric form as primary and also tolerate the word
 * forms `success`/`fail` named in the issue's acceptance criteria.
 */
export interface GrblProbeResultEvent {
  readonly type: 'probeResult';
  /** Machine position reported at probe contact. */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** `true` when the probe made contact within travel (`:1`/`:success`). */
  readonly success: boolean;
  /** The verbatim de-newlined line text including brackets. */
  readonly raw: string;
}

/**
 * A `[GC:...]` G-code modal state report (the `$G` response), e.g.
 * `[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]`. The individual modal words are
 * split on whitespace but not otherwise interpreted here.
 */
export interface GrblModalStateEvent {
  readonly type: 'modalState';
  /** The modal words in report order (`['G0', 'G54', ...]`). */
  readonly words: readonly string[];
  /** The verbatim de-newlined line text including brackets. */
  readonly raw: string;
}

/**
 * A coordinate/offset bracket report from the `$#` response family:
 * `[G54:x,y,z]`, `[G55:...]` … `[G59:...]`, `[G28:...]`, `[G30:...]`,
 * `[G92:...]`, and `[TLO:v]` (single value). The register name is preserved so
 * later modules can key on it; values are parsed to numbers.
 */
export interface GrblOffsetEvent {
  readonly type: 'offset';
  /** The offset register name, e.g. `G54`, `G28`, `TLO`. */
  readonly name: string;
  /** The parsed offset values (three for WCS/`G28`/`G30`/`G92`, one for `TLO`). */
  readonly values: readonly number[];
  /** The verbatim de-newlined line text including brackets. */
  readonly raw: string;
}

/** A `$N=value` settings line, e.g. `$132=100.000`. */
export interface GrblSettingEvent {
  readonly type: 'setting';
  /** The setting number (e.g. `132` from `$132=100.000`). */
  readonly number: number;
  /** The raw value text to the right of `=` (e.g. `100.000`), preserved as-is. */
  readonly value: string;
  /** The verbatim de-newlined line text. */
  readonly raw: string;
}

/**
 * The GRBL welcome banner emitted on connect/reset, e.g. `Grbl 1.1x ['$' for
 * help]`. The Carbide 3D fork's exact banner string is UNVERIFIED (#16), so this
 * is matched loosely (case-insensitive `Grbl <version> …`) rather than against a
 * literal. The version token is captured when present.
 */
export interface GrblWelcomeEvent {
  readonly type: 'welcome';
  /** The version token following `Grbl`, when the banner includes one. */
  readonly version?: string;
  /** The verbatim de-newlined line text. */
  readonly raw: string;
}

/**
 * A `<...>` status report, emitted verbatim for issue #25 to parse. This codec
 * deliberately does not decode the report's fields.
 */
export interface GrblStatusReportRawEvent {
  readonly type: 'statusReportRaw';
  /** The full status report string including the surrounding angle brackets. */
  readonly report: string;
  /** The verbatim de-newlined line text (identical to {@link report}). */
  readonly raw: string;
}

/**
 * Any line the codec does not positively recognise — an OEM/Carbide-specific
 * line, or a malformed payload such as `error:not-a-number`. Callers may log
 * these; the codec never throws.
 */
export interface GrblUnknownEvent {
  readonly type: 'unknown';
  /** The verbatim de-newlined line text. */
  readonly raw: string;
}

/**
 * The discriminated union of every parsed GRBL line. Branch on `.type`; the
 * `unknown` variant is the catch-all for tolerant handling.
 */
export type GrblLineEvent =
  | GrblOkEvent
  | GrblErrorEvent
  | GrblAlarmEvent
  | GrblMessageEvent
  | GrblProbeResultEvent
  | GrblModalStateEvent
  | GrblOffsetEvent
  | GrblSettingEvent
  | GrblWelcomeEvent
  | GrblStatusReportRawEvent
  | GrblUnknownEvent;

/**
 * The stock GRBL 1.1 `ALARM:N` code table, keyed by numeric code.
 *
 * Codes 1–5 are VERIFIED against firmware behaviour in
 * `docs/research/bitsetter-bitzero-protocol.md` (§4); codes 6–10 are the stock
 * GRBL 1.1 homing-failure family, described here from documented behaviour.
 * Descriptions are written from scratch (no GRBL/gSender source was copied).
 *
 * NOTE: `@shapeoko/protocol` also defines an `ALARM_DESCRIPTIONS` table, but it
 * is deliberately PARTIAL (codes 1–5 only). Consolidating onto that single
 * source of truth is deferred: importing `@shapeoko/protocol` from sender-core
 * is not yet possible because the protocol package resolves via
 * `dist/index.d.ts`, which does not exist at `typecheck` time (CI runs typecheck
 * before build). Until that cross-package type resolution is fixed, the table
 * lives here behind {@link describeAlarm} so the swap later happens in exactly
 * one place.
 */
export const GRBL_ALARM_DESCRIPTIONS: Readonly<Record<number, string>> = {
  1: 'Hard limit triggered. A limit switch was hit and motion halted abruptly; machine position is likely lost. Re-homing is strongly recommended.',
  2: 'Soft limit reached. The commanded G-code target exceeds the configured machine travel. Position is retained; the alarm can be safely unlocked.',
  3: 'Reset or abort during a motion cycle. Motion was interrupted while in progress, so machine position is uncertain. Re-homing is strongly recommended.',
  4: 'Probe failure: the probe was already triggered at the start of the move. Check probe wiring and clearance before retrying.',
  5: 'Probe failure: the probe did not make contact within the commanded travel distance. Verify the probe target and connections before retrying.',
  6: 'Homing failure: the active homing cycle was reset before completing.',
  7: 'Homing failure: the safety door was opened during the homing cycle.',
  8: 'Homing failure: the axis could not clear its limit switch during pull-off. Check switch placement, wiring, or increase the pull-off distance.',
  9: 'Homing failure: a limit switch was not found within the configured search distance. Check wiring and travel settings.',
  10: 'Homing failure: the pull-off move exceeded the configured machine travel. Check homing and travel settings.',
};

/**
 * Resolve a human-readable description for a GRBL alarm code, falling back to a
 * generic (but never empty) string for codes outside {@link GRBL_ALARM_DESCRIPTIONS}.
 * This is the single lookup seam intended to later delegate to
 * `@shapeoko/protocol` once cross-package type resolution allows it.
 */
export function describeAlarm(code: number): string {
  return GRBL_ALARM_DESCRIPTIONS[code] ?? `Unrecognized GRBL alarm code ${code}.`;
}

/** Newline byte (`\n`). Lines are delimited on this; a preceding `\r` is stripped. */
const LF = 0x0a;

/** Offset register names recognised in the `$#` bracket response family. */
const OFFSET_REGISTERS: ReadonlySet<string> = new Set([
  'G54',
  'G55',
  'G56',
  'G57',
  'G58',
  'G59',
  'G28',
  'G30',
  'G92',
  'TLO',
]);

/**
 * Parse a comma-separated list of numbers, returning `null` if any element is
 * missing or not a finite number. Used for probe coordinates and offset values;
 * a `null` result routes the line to `unknown` rather than throwing.
 */
function parseNumberList(csv: string): number[] | null {
  const parts = csv.split(',');
  const out: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') {
      return null;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      return null;
    }
    out.push(value);
  }
  return out;
}

/**
 * A streaming parser that converts arbitrarily-chunked GRBL serial bytes into
 * ordered {@link GrblLineEvent}s.
 *
 * Usage: create one instance per connection and feed every transport `data`
 * chunk to {@link push}; the codec buffers partial lines internally across
 * calls. It is stateful (holds the pending trailing bytes) and single-threaded
 * by nature of Node's event loop — do not share one instance across connections.
 */
export class GrblLineCodec {
  /** Trailing bytes received but not yet terminated by a newline. */
  private pending: Buffer = Buffer.alloc(0);

  /**
   * Feed a chunk of received bytes. Emits one {@link GrblLineEvent} per complete
   * newline-terminated line (in receive order) and retains any incomplete
   * trailing bytes for the next call. Blank lines are ignored. Never throws.
   */
  push(chunk: Buffer): GrblLineEvent[] {
    this.pending =
      this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);

    const events: GrblLineEvent[] = [];
    let lineStart = 0;
    for (let i = 0; i < this.pending.length; i += 1) {
      if (this.pending[i] !== LF) {
        continue;
      }
      const lineBytes = this.pending.subarray(lineStart, i);
      lineStart = i + 1;
      const event = this.parseLine(decodeLine(lineBytes));
      if (event !== null) {
        events.push(event);
      }
    }

    this.pending = lineStart === 0 ? this.pending : this.pending.subarray(lineStart);
    return events;
  }

  /**
   * Discard any buffered partial line. Call on reconnect so stale trailing bytes
   * from a previous session cannot corrupt the first line of the next one.
   */
  reset(): void {
    this.pending = Buffer.alloc(0);
  }

  /**
   * Classify a single de-newlined line into its {@link GrblLineEvent} variant,
   * or `null` for a blank line. This is the heart of the codec; every branch is
   * ordered from most specific to the `unknown` catch-all and none throw.
   */
  private parseLine(raw: string): GrblLineEvent | null {
    const line = raw.trim();
    if (line === '') {
      return null;
    }

    if (line === 'ok') {
      return { type: 'ok', raw };
    }

    const errorMatch = /^error:(.*)$/i.exec(line);
    if (errorMatch) {
      const code = parseIntStrict(errorMatch[1]);
      return code === null ? { type: 'unknown', raw } : { type: 'error', code, raw };
    }

    const alarmMatch = /^alarm:(.*)$/i.exec(line);
    if (alarmMatch) {
      const code = parseIntStrict(alarmMatch[1]);
      return code === null
        ? { type: 'unknown', raw }
        : { type: 'alarm', code, text: describeAlarm(code), raw };
    }

    // Status report: emitted raw for issue #25; contents are NOT parsed here.
    if (line.startsWith('<') && line.endsWith('>')) {
      return { type: 'statusReportRaw', report: line, raw };
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      return this.parseBracket(line.slice(1, -1), raw);
    }

    const settingMatch = /^\$(\d+)=(.*)$/.exec(line);
    if (settingMatch) {
      // The `\d+` guarantees a parseable integer; the value is preserved as text.
      return {
        type: 'setting',
        number: Number(settingMatch[1]),
        value: settingMatch[2] ?? '',
        raw,
      };
    }

    // Loose welcome match — the Carbide fork's exact banner is UNVERIFIED (#16).
    const welcomeMatch = /^grbl\s+(\S+)/i.exec(line);
    if (welcomeMatch) {
      return { type: 'welcome', version: welcomeMatch[1], raw };
    }
    if (/^grbl\b/i.test(line)) {
      return { type: 'welcome', raw };
    }

    return { type: 'unknown', raw };
  }

  /**
   * Parse the inner text of a `[...]` bracket message (brackets already stripped)
   * into the appropriate variant, falling back to `unknown` for OEM/Carbide
   * bracket forms this codec does not model.
   */
  private parseBracket(inner: string, raw: string): GrblLineEvent {
    if (inner.startsWith('MSG:')) {
      return { type: 'message', text: inner.slice('MSG:'.length), raw };
    }

    if (inner.startsWith('PRB:')) {
      return parseProbe(inner.slice('PRB:'.length), raw);
    }

    if (inner.startsWith('GC:')) {
      const words = inner.slice('GC:'.length).trim().split(/\s+/).filter(Boolean);
      return { type: 'modalState', words, raw };
    }

    const colon = inner.indexOf(':');
    if (colon > 0) {
      const name = inner.slice(0, colon);
      if (OFFSET_REGISTERS.has(name)) {
        const values = parseNumberList(inner.slice(colon + 1));
        if (values !== null) {
          return { type: 'offset', name, values, raw };
        }
      }
    }

    return { type: 'unknown', raw };
  }
}

/**
 * Parse the body of a `[PRB:...]` report (the text after `PRB:`), e.g.
 * `0.000,0.000,0.000:1`. Returns an `unknown` event on any malformed shape so
 * the codec stays tolerant.
 */
function parseProbe(body: string, raw: string): GrblLineEvent {
  const lastColon = body.lastIndexOf(':');
  if (lastColon <= 0) {
    return { type: 'unknown', raw };
  }
  const coords = parseNumberList(body.slice(0, lastColon));
  if (coords === null || coords.length !== 3) {
    return { type: 'unknown', raw };
  }
  const flag = body
    .slice(lastColon + 1)
    .trim()
    .toLowerCase();
  let success: boolean;
  if (flag === '1' || flag === 'success' || flag === 'true') {
    success = true;
  } else if (flag === '0' || flag === 'fail' || flag === 'false') {
    success = false;
  } else {
    return { type: 'unknown', raw };
  }
  // Lengths validated above, so these indexed reads are known-present.
  const [x, y, z] = coords as [number, number, number];
  return { type: 'probeResult', position: { x, y, z }, success, raw };
}

/**
 * Decode a single line's bytes to a string, stripping a single trailing `\r`
 * (from CRLF terminators) but preserving everything else verbatim.
 */
function decodeLine(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/**
 * Parse a strictly-integer numeric payload (optionally sign-prefixed), returning
 * `null` for anything non-integer. Used for `error:`/`ALARM:` codes so malformed
 * payloads such as `error:not-a-number` fall through to `unknown`.
 */
function parseIntStrict(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
