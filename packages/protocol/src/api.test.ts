import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  REALTIME_COMMAND,
  type ClientCommand,
  type JogAxis,
  type JogCommand,
  type ProtocolMessage,
  type RealtimeCommandName,
  type ServerEvent,
} from './api.js';

describe('real-time command bytes', () => {
  it('matches the verified GRBL byte reference (protocol doc §5.2)', () => {
    expect(REALTIME_COMMAND.STATUS_REPORT).toBe(0x3f);
    expect(REALTIME_COMMAND.FEED_HOLD).toBe(0x21);
    expect(REALTIME_COMMAND.CYCLE_START).toBe(0x7e);
    expect(REALTIME_COMMAND.SOFT_RESET).toBe(0x18);
    expect(REALTIME_COMMAND.JOG_CANCEL).toBe(0x85);
  });

  it('names, but does not include, $X (alarm unlock is not a real-time byte)', () => {
    const names = Object.keys(REALTIME_COMMAND) as RealtimeCommandName[];
    expect(names).not.toContain('UNLOCK');
    expect(names).not.toContain('ALARM_UNLOCK');
  });
});

describe('ClientCommand union', () => {
  it('is discriminated on type', () => {
    const commands: ClientCommand[] = [
      { type: 'connect', port: '/dev/ttyUSB0', baudRate: 115200 },
      { type: 'disconnect' },
      { type: 'sendLine', line: 'G0 X0' },
      { type: 'realtime', command: 'JOG_CANCEL' },
      { type: 'jog', axis: 'X', distanceMm: 0.1, feedMmPerMin: 1000 },
      { type: 'streamStart', lines: ['G0 X0', 'G0 Y0'], name: 'job' },
      { type: 'streamPause' },
      { type: 'streamResume' },
      { type: 'streamStop' },
      { type: 'home' },
      { type: 'unlockAlarm' },
      { type: 'setWorkOffset', x: 0, y: 0, z: 0 },
      { type: 'getSettings' },
    ];
    expect(commands).toHaveLength(13);
  });

  it('narrows a jog command on its discriminant', () => {
    const cmd: ClientCommand = {
      type: 'jog',
      axis: 'Z',
      distanceMm: -1,
      feedMmPerMin: 500,
    };
    if (cmd.type === 'jog') {
      expectTypeOf(cmd.axis).toEqualTypeOf<JogAxis>();
      expect(cmd.distanceMm).toBe(-1);
    }
  });

  it('restricts a jog axis to X/Y/Z (never OFF)', () => {
    expectTypeOf<JogCommand['axis']>().toEqualTypeOf<'X' | 'Y' | 'Z'>();
    // @ts-expect-error — a jog cannot target the OFF selector position.
    const bad: JogCommand = { type: 'jog', axis: 'OFF', distanceMm: 1, feedMmPerMin: 1 };
    void bad;
  });

  it('rejects an unknown realtime command name', () => {
    // @ts-expect-error — 'EXPLODE' is not a known real-time command.
    const bad: ClientCommand = { type: 'realtime', command: 'EXPLODE' };
    void bad;
  });

  it('rejects an unknown command type', () => {
    // @ts-expect-error — 'teleport' is not a client command.
    const bad: ClientCommand = { type: 'teleport' };
    void bad;
  });
});

describe('ServerEvent union', () => {
  it('is discriminated on type', () => {
    const events: ServerEvent[] = [
      { type: 'connection', state: 'connected' },
      { type: 'welcome', line: "Grbl 1.1f ['$' for help]" },
      { type: 'status', report: { state: 'Idle' } },
      { type: 'alarm', code: 5, message: 'probe fail' },
      { type: 'error', code: 9 },
      { type: 'ok' },
      { type: 'settings', settings: { 6: 1 } },
      { type: 'probeResult', success: true, x: 0, y: 0, z: -1.5 },
      { type: 'streamProgress', sent: 10, total: 100, phase: 'running' },
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'panel', frame: { type: 'button', button: 'start', edge: 'down' } },
    ];
    expect(events).toHaveLength(11);
  });

  it('narrows an alarm event on its discriminant', () => {
    const ev: ServerEvent = { type: 'alarm', code: 4 };
    if (ev.type === 'alarm') {
      expectTypeOf(ev.code).toEqualTypeOf<number>();
      expect(ev.code).toBe(4);
    }
  });

  it('rejects an unknown event type', () => {
    // @ts-expect-error — 'explosion' is not a server event.
    const bad: ServerEvent = { type: 'explosion' };
    void bad;
  });
});

describe('ProtocolMessage', () => {
  it('spans both directions', () => {
    const client: ProtocolMessage = { type: 'home' };
    const server: ProtocolMessage = { type: 'ok' };
    expect(client.type).toBe('home');
    expect(server.type).toBe('ok');
  });
});
