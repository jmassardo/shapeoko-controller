/**
 * Tests for the incremental GRBL line-protocol codec (issue #24).
 *
 * Coverage is organised around the acceptance criteria: byte-stream framing
 * (chunk boundaries, CRLF/LF terminators, trailing-partial retention), the full
 * set of known line variants, the complete `ALARM:N` code table, and tolerant
 * handling of unknown/malformed lines (which must never throw).
 */

import { describe, expect, it } from 'vitest';

import {
  GrblLineCodec,
  GRBL_ALARM_DESCRIPTIONS,
  describeAlarm,
  type GrblAlarmEvent,
  type GrblLineEvent,
  type GrblOffsetEvent,
  type GrblProbeResultEvent,
} from './lineCodec.js';

/** Feed a whole string through a fresh codec and return the emitted events. */
function parseAll(input: string): GrblLineEvent[] {
  const codec = new GrblLineCodec();
  return codec.push(Buffer.from(input, 'utf8'));
}

/** Parse a single line and assert exactly one event was produced. */
function parseOne(input: string): GrblLineEvent {
  const events = parseAll(input);
  expect(events).toHaveLength(1);
  // Length asserted above.
  return events[0] as GrblLineEvent;
}

describe('GrblLineCodec framing (AC1)', () => {
  it('emits complete lines in order and retains an incomplete trailing line', () => {
    const codec = new GrblLineCodec();

    const first = codec.push(Buffer.from('ok\r\nerror:2\r\nAL'));
    expect(first.map((e) => e.type)).toEqual(['ok', 'error']);

    // The dangling "AL" is retained until the next chunk completes it.
    const second = codec.push(Buffer.from('ARM:1\r\n'));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'alarm', code: 1 });
  });

  it('reassembles a single line split across many chunks', () => {
    const codec = new GrblLineCodec();
    expect(codec.push(Buffer.from('o'))).toEqual([]);
    expect(codec.push(Buffer.from('k'))).toEqual([]);
    const done = codec.push(Buffer.from('\r\n'));
    expect(done).toEqual([{ type: 'ok', raw: 'ok' }]);
  });

  it('handles multiple complete lines within a single chunk', () => {
    const events = parseAll('ok\r\nok\r\nok\r\n');
    expect(events.map((e) => e.type)).toEqual(['ok', 'ok', 'ok']);
  });

  it('tolerates bare LF line terminators (no CR)', () => {
    const events = parseAll('ok\nerror:1\n');
    expect(events[0]).toEqual({ type: 'ok', raw: 'ok' });
    expect(events[1]).toMatchObject({ type: 'error', code: 1 });
  });

  it('ignores blank lines between real lines', () => {
    const events = parseAll('ok\r\n\r\n\r\nok\r\n');
    expect(events.map((e) => e.type)).toEqual(['ok', 'ok']);
  });

  it('does not emit anything for a chunk with no newline', () => {
    const codec = new GrblLineCodec();
    expect(codec.push(Buffer.from('partial line without terminator'))).toEqual([]);
  });

  it('reassembles a line when its CRLF terminator is split across chunks', () => {
    // Byte-level split of "ok\r\n": '\r' arrives in a separate chunk from '\n'.
    const codec = new GrblLineCodec();
    expect(codec.push(Buffer.from('ok\r'))).toEqual([]);
    expect(codec.push(Buffer.from('\n'))).toEqual([{ type: 'ok', raw: 'ok' }]);
  });

  it('reassembles a multi-byte UTF-8 codepoint split across chunks', () => {
    // Encode at the byte level, then cut the buffer BETWEEN the two bytes of
    // 'é' (0xC3 0xA9). Splitting on real bytes (not string literals) is the
    // whole point: it proves the codec buffers raw bytes and only decodes UTF-8
    // once a full framed line is present, so a torn codepoint reassembles clean.
    const encoded = Buffer.from('[MSG:café]\r\n', 'utf8');
    const splitAt = encoded.indexOf(0xc3) + 1; // between 0xC3 and 0xA9 of 'é'
    expect(encoded[splitAt]).toBe(0xa9);

    const codec = new GrblLineCodec();
    expect(codec.push(encoded.subarray(0, splitAt))).toEqual([]);

    const events = codec.push(encoded.subarray(splitAt));
    expect(events).toEqual([{ type: 'message', text: 'café', raw: '[MSG:café]' }]);
  });

  it('reset() discards buffered partial bytes', () => {
    const codec = new GrblLineCodec();
    codec.push(Buffer.from('garba'));
    codec.reset();
    // After reset the leftover "garba" is gone; only "ok" is parsed.
    expect(codec.push(Buffer.from('ok\r\n'))).toEqual([{ type: 'ok', raw: 'ok' }]);
  });
});

describe('GrblLineCodec known variants (AC2)', () => {
  it('parses ok', () => {
    expect(parseOne('ok\r\n')).toEqual({ type: 'ok', raw: 'ok' });
  });

  it('parses error:2 preserving the numeric code', () => {
    expect(parseOne('error:2\r\n')).toEqual({ type: 'error', code: 2, raw: 'error:2' });
  });

  it('parses ALARM:5 into the alarm variant', () => {
    const event = parseOne('ALARM:5\r\n');
    expect(event).toMatchObject({ type: 'alarm', code: 5 });
  });

  it('parses a $ setting line', () => {
    expect(parseOne('$132=100.000\r\n')).toEqual({
      type: 'setting',
      number: 132,
      value: '100.000',
      raw: '$132=100.000',
    });
  });

  it('parses a welcome banner with a loose, case-insensitive match', () => {
    expect(parseOne("Grbl 1.1x ['$' for help]\r\n")).toEqual({
      type: 'welcome',
      version: '1.1x',
      raw: "Grbl 1.1x ['$' for help]",
    });
  });

  it('matches an unverified Carbide-style welcome banner and a version-less banner', () => {
    expect(parseOne('grbl 1.1f-carbide-anything\r\n')).toMatchObject({
      type: 'welcome',
      version: '1.1f-carbide-anything',
    });
    expect(parseOne('Grbl\r\n')).toEqual({ type: 'welcome', raw: 'Grbl' });
  });

  it('emits status reports raw without parsing their fields (deferred to #25)', () => {
    const report = '<Idle|MPos:0.000,0.000,0.000|FS:0,0>';
    expect(parseOne(`${report}\r\n`)).toEqual({
      type: 'statusReportRaw',
      report,
      raw: report,
    });
  });

  it('routes a bracket message to the message variant', () => {
    expect(parseOne("[MSG:'$H'|'$X' to unlock]\r\n")).toEqual({
      type: 'message',
      text: "'$H'|'$X' to unlock",
      raw: "[MSG:'$H'|'$X' to unlock]",
    });
  });
});

describe('GrblLineCodec bracket detail retention (AC3)', () => {
  it('retains raw text and typed fields for [MSG:...]', () => {
    const event = parseOne('[MSG:Enabled]\r\n');
    expect(event).toEqual({ type: 'message', text: 'Enabled', raw: '[MSG:Enabled]' });
  });

  it('parses [PRB:x,y,z:1] with numeric success flag', () => {
    const event = parseOne('[PRB:1.000,2.000,3.000:1]\r\n') as GrblProbeResultEvent;
    expect(event.type).toBe('probeResult');
    expect(event.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(event.success).toBe(true);
    expect(event.raw).toBe('[PRB:1.000,2.000,3.000:1]');
  });

  it('parses [PRB:...:0] as a failed probe', () => {
    const event = parseOne('[PRB:0.000,0.000,-5.000:0]\r\n') as GrblProbeResultEvent;
    expect(event.success).toBe(false);
    expect(event.position).toEqual({ x: 0, y: 0, z: -5 });
  });

  it('tolerates the word form [PRB:x,y,z:success] (AC3)', () => {
    const event = parseOne('[PRB:1.5,2.5,3.5:success]\r\n') as GrblProbeResultEvent;
    expect(event.type).toBe('probeResult');
    expect(event.success).toBe(true);
    expect(event.position).toEqual({ x: 1.5, y: 2.5, z: 3.5 });
  });

  it('parses [GC:...] modal state into ordered words', () => {
    const event = parseOne('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\n');
    expect(event).toEqual({
      type: 'modalState',
      words: ['G0', 'G54', 'G17', 'G21', 'G90', 'G94', 'M5', 'M9', 'T0', 'F0', 'S0'],
      raw: '[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]',
    });
  });

  it('parses [G54:...] work-coordinate offsets', () => {
    const event = parseOne('[G54:10.000,20.000,30.000]\r\n') as GrblOffsetEvent;
    expect(event.type).toBe('offset');
    expect(event.name).toBe('G54');
    expect(event.values).toEqual([10, 20, 30]);
  });

  it('parses [G28:...] and [G30:...] and [G92:...] offset registers', () => {
    expect((parseOne('[G28:1.000,2.000,3.000]\r\n') as GrblOffsetEvent).name).toBe('G28');
    expect((parseOne('[G30:4.000,5.000,6.000]\r\n') as GrblOffsetEvent).name).toBe('G30');
    expect((parseOne('[G92:0.000,0.000,0.000]\r\n') as GrblOffsetEvent).values).toEqual([0, 0, 0]);
  });

  it('parses the single-valued [TLO:v] tool-length offset', () => {
    const event = parseOne('[TLO:0.500]\r\n') as GrblOffsetEvent;
    expect(event.name).toBe('TLO');
    expect(event.values).toEqual([0.5]);
  });

  it('parses every G55–G59 work-coordinate register', () => {
    for (const name of ['G55', 'G56', 'G57', 'G58', 'G59']) {
      const event = parseOne(`[${name}:0.000,0.000,0.000]\r\n`) as GrblOffsetEvent;
      expect(event.type).toBe('offset');
      expect(event.name).toBe(name);
    }
  });
});

describe('GrblLineCodec unknown and malformed handling (AC4, AC6)', () => {
  it('falls through unknown Carbide/OEM lines to the unknown variant without throwing', () => {
    expect(parseOne('[VER:1.1f.20170801:Carbide]\r\n')).toEqual({
      type: 'unknown',
      raw: '[VER:1.1f.20170801:Carbide]',
    });
    expect(parseOne('some proprietary carbide banter\r\n')).toEqual({
      type: 'unknown',
      raw: 'some proprietary carbide banter',
    });
  });

  it('treats a non-numeric error payload as unknown, not a crash', () => {
    expect(parseOne('error:not-a-number\r\n')).toEqual({
      type: 'unknown',
      raw: 'error:not-a-number',
    });
  });

  it('treats a non-numeric alarm payload as unknown', () => {
    expect(parseOne('ALARM:oops\r\n')).toEqual({ type: 'unknown', raw: 'ALARM:oops' });
  });

  it('treats a malformed probe report as unknown', () => {
    // Only two coordinates instead of three.
    expect(parseOne('[PRB:1.000,2.000:1]\r\n')).toMatchObject({ type: 'unknown' });
    // Non-numeric coordinate.
    expect(parseOne('[PRB:x,y,z:1]\r\n')).toMatchObject({ type: 'unknown' });
    // Unrecognised flag.
    expect(parseOne('[PRB:1.0,2.0,3.0:maybe]\r\n')).toMatchObject({ type: 'unknown' });
    // No flag separator.
    expect(parseOne('[PRB:1.0,2.0,3.0]\r\n')).toMatchObject({ type: 'unknown' });
  });

  it('treats an offset register with non-numeric values as unknown', () => {
    expect(parseOne('[G54:a,b,c]\r\n')).toMatchObject({ type: 'unknown' });
  });

  it('never throws across a stress mix of malformed lines', () => {
    const codec = new GrblLineCodec();
    const junk = [
      'error:',
      'ALARM:',
      '[',
      ']',
      '[]',
      '<unterminated',
      '$=noNumber',
      '$abc=1',
      '[PRB:]',
      '\x00\x01\x02',
      'ok',
    ].join('\r\n');
    expect(() => codec.push(Buffer.from(`${junk}\r\n`))).not.toThrow();
  });
});

describe('GRBL alarm-code table (AC5)', () => {
  it('maps ALARM:2, :3, :4, :5 to their documented descriptions', () => {
    const soft = parseOne('ALARM:2\r\n') as GrblAlarmEvent;
    const abort = parseOne('ALARM:3\r\n') as GrblAlarmEvent;
    const preTrig = parseOne('ALARM:4\r\n') as GrblAlarmEvent;
    const noContact = parseOne('ALARM:5\r\n') as GrblAlarmEvent;

    expect(soft.code).toBe(2);
    expect(soft.text.toLowerCase()).toContain('soft limit');
    expect(abort.code).toBe(3);
    expect(abort.text.toLowerCase()).toContain('abort');
    expect(preTrig.code).toBe(4);
    expect(preTrig.text.toLowerCase()).toContain('already triggered');
    expect(noContact.code).toBe(5);
    expect(noContact.text.toLowerCase()).toContain('did not make contact');
  });

  it('provides a non-empty description for the full stock table (codes 1–10)', () => {
    for (let code = 1; code <= 10; code += 1) {
      expect(GRBL_ALARM_DESCRIPTIONS[code]).toBeDefined();
      const event = parseOne(`ALARM:${code}\r\n`) as GrblAlarmEvent;
      expect(event.type).toBe('alarm');
      expect(event.text.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a generic description for codes outside the table', () => {
    const event = parseOne('ALARM:99\r\n') as GrblAlarmEvent;
    expect(event.code).toBe(99);
    expect(event.text).toContain('99');
    expect(describeAlarm(99)).toBe(event.text);
  });

  it('describeAlarm returns table text for a known code', () => {
    expect(describeAlarm(1)).toBe(GRBL_ALARM_DESCRIPTIONS[1]);
  });
});
