/**
 * Tests for the panel wire-format constants, message-type guard, payload codecs,
 * and — most importantly — the DRIFT GUARD that mechanically enforces "byte-for-
 * byte compatible with #54" against the normative C header and the second public
 * TypeScript mirror in `@shapeoko/protocol`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PANEL_ACK_PAYLOAD_LEN,
  PANEL_CMD_PAYLOAD_LEN,
  PANEL_EVENT_PAYLOAD_LEN,
  PANEL_FRAME_OVERHEAD,
  PANEL_INFO_PAYLOAD_LEN,
  PANEL_MAX_FRAME_LEN,
  PANEL_MAX_PAYLOAD_LEN,
  PANEL_MESSAGE_TYPE_VALUES,
  PANEL_MIN_FRAME_LEN,
  PANEL_SYNC0,
  PANEL_SYNC1,
  PanelMessageType,
  decodePanelAckPayload,
  decodePanelCmdPayload,
  decodePanelEventPayload,
  decodePanelInfoPayload,
  encodePanelAckPayload,
  encodePanelCmdPayload,
  encodePanelEventPayload,
  encodePanelHelloPayload,
  encodePanelInfoPayload,
  isPanelMessageType,
} from './frameTypes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// From packages/sender-core/src/panel: up 4 to the repo root, then firmware.
const HEADER_PATH = resolve(HERE, '../../../../firmware/panel/include/frame_types.h');
// From packages/sender-core/src/panel: up 3 to packages, then protocol.
const PROTOCOL_MIRROR_PATH = resolve(HERE, '../../../protocol/src/panel.ts');

/** Parse a C/TS numeric literal (`0xAA` or `64`) to a number, or fail loudly. */
function parseNumericLiteral(raw: string, what: string): number {
  const trimmed = raw.trim();
  const value =
    trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? parseInt(trimmed, 16)
      : parseInt(trimmed, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`could not parse numeric literal for ${what}: "${raw}"`);
  }
  return value;
}

/** Extract a single named constant from arbitrary source text via a value regex. */
function extractOne(text: string, re: RegExp, what: string, sourceLabel: string): number {
  const m = re.exec(text);
  if (m === null || m[1] === undefined) {
    throw new Error(`drift guard: could not find ${what} in ${sourceLabel}`);
  }
  return parseNumericLiteral(m[1], `${what} in ${sourceLabel}`);
}

describe('panel wire constants', () => {
  it('mirror the #54 header values', () => {
    expect(PANEL_SYNC0).toBe(0xaa);
    expect(PANEL_SYNC1).toBe(0x55);
    expect(PANEL_MAX_PAYLOAD_LEN).toBe(64);
    expect(PANEL_FRAME_OVERHEAD).toBe(7);
    expect(PANEL_MIN_FRAME_LEN).toBe(7);
    expect(PANEL_MAX_FRAME_LEN).toBe(71);
  });
});

describe('PanelMessageType', () => {
  it('has the normative TYPE byte values', () => {
    expect(PanelMessageType.Hello).toBe(0x00);
    expect(PanelMessageType.Info).toBe(0x01);
    expect(PanelMessageType.Status).toBe(0x02);
    expect(PanelMessageType.Event).toBe(0x03);
    expect(PanelMessageType.Cmd).toBe(0x04);
    expect(PanelMessageType.Ack).toBe(0x05);
  });

  it('enumerates every known type exactly once', () => {
    expect([...PANEL_MESSAGE_TYPE_VALUES]).toEqual([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  });

  it('type guard accepts every known type byte', () => {
    for (const t of PANEL_MESSAGE_TYPE_VALUES) {
      expect(isPanelMessageType(t)).toBe(true);
    }
  });

  it('type guard rejects unknown type bytes', () => {
    for (const b of [0x06, 0x7f, 0xff, -1, 0.5]) {
      expect(isPanelMessageType(b)).toBe(false);
    }
  });
});

describe('INFO payload codec', () => {
  it('round-trips fields with little-endian u32s', () => {
    const p = {
      fwMajor: 1,
      fwMinor: 2,
      fwPatch: 3,
      bootCount: 0x11223344,
      capabilities: 0xa0b0c0d0,
    };
    const bytes = encodePanelInfoPayload(p);
    expect(bytes.length).toBe(PANEL_INFO_PAYLOAD_LEN);
    // boot_count little-endian: 0x44 0x33 0x22 0x11 at offset 3.
    expect([...bytes.slice(3, 7)]).toEqual([0x44, 0x33, 0x22, 0x11]);
    const decoded = decodePanelInfoPayload(bytes);
    expect(decoded).toEqual({ ok: true, value: p });
  });

  it('rejects short input without throwing', () => {
    const decoded = decodePanelInfoPayload(new Uint8Array(PANEL_INFO_PAYLOAD_LEN - 1));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.reason).toContain('INFO');
    }
  });

  it('decodes correctly when the payload is a non-zero-offset view', () => {
    const p = { fwMajor: 9, fwMinor: 8, fwPatch: 7, bootCount: 5, capabilities: 42 };
    const inner = encodePanelInfoPayload(p);
    // Wrap in a larger buffer to exercise byteOffset handling in the DataView.
    const outer = new Uint8Array(inner.length + 3);
    outer.set(inner, 3);
    const view = outer.subarray(3);
    expect(decodePanelInfoPayload(view)).toEqual({ ok: true, value: p });
  });
});

describe('EVENT / CMD / ACK payload codecs', () => {
  it('EVENT round-trips id + flags', () => {
    const bytes = encodePanelEventPayload({ eventId: 0x2a, flags: 0x80 });
    expect([...bytes]).toEqual([0x2a, 0x80]);
    expect(decodePanelEventPayload(bytes)).toEqual({
      ok: true,
      value: { eventId: 0x2a, flags: 0x80 },
    });
  });

  it('EVENT ignores trailing reserved bytes (#56-#65 own their layout)', () => {
    const withReserved = Uint8Array.of(0x01, 0x02, 0xff, 0xee);
    expect(decodePanelEventPayload(withReserved)).toEqual({
      ok: true,
      value: { eventId: 0x01, flags: 0x02 },
    });
  });

  it('CMD round-trips led + dust', () => {
    const bytes = encodePanelCmdPayload({ ledPattern: 0x03, dustMode: 0x01 });
    expect([...bytes]).toEqual([0x03, 0x01]);
    expect(decodePanelCmdPayload(bytes)).toEqual({
      ok: true,
      value: { ledPattern: 0x03, dustMode: 0x01 },
    });
  });

  it('ACK round-trips acked_seq + acked_type', () => {
    const bytes = encodePanelAckPayload({ ackedSeq: 0x7b, ackedType: PanelMessageType.Event });
    expect([...bytes]).toEqual([0x7b, 0x03]);
    expect(decodePanelAckPayload(bytes)).toEqual({
      ok: true,
      value: { ackedSeq: 0x7b, ackedType: 0x03 },
    });
  });

  it('every fixed decoder rejects short input without throwing', () => {
    expect(decodePanelEventPayload(new Uint8Array(PANEL_EVENT_PAYLOAD_LEN - 1)).ok).toBe(false);
    expect(decodePanelCmdPayload(new Uint8Array(PANEL_CMD_PAYLOAD_LEN - 1)).ok).toBe(false);
    expect(decodePanelAckPayload(new Uint8Array(PANEL_ACK_PAYLOAD_LEN - 1)).ok).toBe(false);
  });

  it('HELLO payload is empty', () => {
    expect(encodePanelHelloPayload().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DRIFT GUARD (required deliverable D): the C header and BOTH TypeScript mirrors
// must agree byte-for-byte. Read them as TEXT at runtime and assert equality.
// If the header is missing, this MUST fail (not skip), so a moved/renamed header
// can never silently disable the check.
// ---------------------------------------------------------------------------
describe('drift guard vs the #54 normative header', () => {
  const header = readFileSync(HEADER_PATH, 'utf8');

  it('reads the normative header (fails, never skips, if it is missing)', () => {
    // readFileSync above throws if the file is absent, failing the suite loudly.
    expect(header.length).toBeGreaterThan(0);
  });

  it('SYNC / length / overhead constants match the header', () => {
    const kSync0 = extractOne(header, /kSync0\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/, 'kSync0', 'header');
    const kSync1 = extractOne(header, /kSync1\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/, 'kSync1', 'header');
    const kMaxPayloadLen = extractOne(
      header,
      /kMaxPayloadLen\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/,
      'kMaxPayloadLen',
      'header',
    );
    const kFrameOverhead = extractOne(
      header,
      /kFrameOverhead\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/,
      'kFrameOverhead',
      'header',
    );

    expect(kSync0, 'kSync0 header vs TS mirror drift').toBe(PANEL_SYNC0);
    expect(kSync1, 'kSync1 header vs TS mirror drift').toBe(PANEL_SYNC1);
    expect(kMaxPayloadLen, 'kMaxPayloadLen header vs TS mirror drift').toBe(PANEL_MAX_PAYLOAD_LEN);
    expect(kFrameOverhead, 'kFrameOverhead header vs TS mirror drift').toBe(PANEL_FRAME_OVERHEAD);
  });

  it('every MessageType enumerator matches the header', () => {
    const wanted: ReadonlyArray<readonly [string, number]> = [
      ['kHello', PanelMessageType.Hello],
      ['kInfo', PanelMessageType.Info],
      ['kStatus', PanelMessageType.Status],
      ['kEvent', PanelMessageType.Event],
      ['kCmd', PanelMessageType.Cmd],
      ['kAck', PanelMessageType.Ack],
    ];
    for (const [name, tsValue] of wanted) {
      const re = new RegExp(`${name}\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)\\s*,`);
      const headerValue = extractOne(header, re, name, 'header');
      expect(
        headerValue,
        `${name} header value ${String(headerValue)} != TS ${String(tsValue)}`,
      ).toBe(tsValue);
    }
  });
});

describe('drift guard vs the @shapeoko/protocol public mirror', () => {
  const mirror = readFileSync(PROTOCOL_MIRROR_PATH, 'utf8');

  it('reads the protocol mirror (fails, never skips, if it is missing)', () => {
    expect(mirror.length).toBeGreaterThan(0);
  });

  it('PANEL_WIRE_* constants match the sender-core mirror', () => {
    const sync0 = extractOne(
      mirror,
      /PANEL_WIRE_SYNC0\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/,
      'PANEL_WIRE_SYNC0',
      'protocol mirror',
    );
    const sync1 = extractOne(
      mirror,
      /PANEL_WIRE_SYNC1\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/,
      'PANEL_WIRE_SYNC1',
      'protocol mirror',
    );
    const maxPayload = extractOne(
      mirror,
      /PANEL_WIRE_MAX_PAYLOAD_LEN\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/,
      'PANEL_WIRE_MAX_PAYLOAD_LEN',
      'protocol mirror',
    );
    const overhead = extractOne(
      mirror,
      /PANEL_WIRE_FRAME_OVERHEAD\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/,
      'PANEL_WIRE_FRAME_OVERHEAD',
      'protocol mirror',
    );

    expect(sync0).toBe(PANEL_SYNC0);
    expect(sync1).toBe(PANEL_SYNC1);
    expect(maxPayload).toBe(PANEL_MAX_PAYLOAD_LEN);
    expect(overhead).toBe(PANEL_FRAME_OVERHEAD);
  });

  it('PanelMessageType values match the sender-core mirror', () => {
    const wanted: ReadonlyArray<readonly [string, number]> = [
      ['Hello', PanelMessageType.Hello],
      ['Info', PanelMessageType.Info],
      ['Status', PanelMessageType.Status],
      ['Event', PanelMessageType.Event],
      ['Cmd', PanelMessageType.Cmd],
      ['Ack', PanelMessageType.Ack],
    ];
    for (const [name, tsValue] of wanted) {
      const re = new RegExp(`${name}\\s*:\\s*(0x[0-9A-Fa-f]+|\\d+)\\s*,`);
      const mirrorValue = extractOne(mirror, re, name, 'protocol mirror');
      expect(mirrorValue, `${name} protocol-mirror value != sender-core`).toBe(tsValue);
    }
  });
});
