import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ALARM_DESCRIPTIONS,
  MACHINE_STATES,
  PROBE_ALARM,
  describeAlarm,
  isMachineState,
  type AccessoryState,
  type MachineState,
  type PinFlags,
  type Position,
  type StatusReport,
} from './machine.js';

describe('MachineState', () => {
  it('models exactly the nine GRBL 1.1 states', () => {
    expect([...MACHINE_STATES]).toEqual([
      'Idle',
      'Run',
      'Hold',
      'Jog',
      'Alarm',
      'Door',
      'Check',
      'Home',
      'Sleep',
    ]);
  });

  it('narrows known state strings and rejects others', () => {
    expect(isMachineState('Idle')).toBe(true);
    expect(isMachineState('Alarm')).toBe(true);
    expect(isMachineState('Running')).toBe(false);
    expect(isMachineState(42)).toBe(false);
  });

  it('is a closed union at the type level', () => {
    expectTypeOf<MachineState>().toEqualTypeOf<
      'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep'
    >();
    // @ts-expect-error — 'Running' is not a GRBL machine state.
    const bad: MachineState = 'Running';
    void bad;
  });
});

describe('alarm codes', () => {
  it('describes the verified probe alarms', () => {
    expect(describeAlarm(4)).toMatch(/already triggered/i);
    expect(describeAlarm(5)).toMatch(/did not contact/i);
  });

  it('returns undefined for unknown codes so callers still surface them', () => {
    expect(describeAlarm(99)).toBeUndefined();
  });

  it('names the two probe alarm codes', () => {
    expect(PROBE_ALARM.PROBE_PRE_TRIGGERED).toBe(4);
    expect(PROBE_ALARM.PROBE_NO_CONTACT).toBe(5);
    expect(ALARM_DESCRIPTIONS[PROBE_ALARM.PROBE_NO_CONTACT]).toBeDefined();
  });
});

describe('StatusReport shape', () => {
  it('requires only state; all other fields are optional', () => {
    const minimal: StatusReport = { state: 'Idle' };
    expect(minimal.state).toBe('Idle');
    expect(minimal.machinePosition).toBeUndefined();
  });

  it('carries positions, feed/spindle, overrides, accessories, and pins', () => {
    const mpos: Position = { x: 1, y: 2, z: 3 };
    const pins: PinFlags = { probe: true, limitZ: true };
    const accessories: AccessoryState = { spindleCw: true, flood: true };
    const report: StatusReport = {
      state: 'Run',
      machinePosition: mpos,
      workCoordinateOffset: { x: 0, y: 0, z: -5 },
      feedSpindle: { feed: 500, spindle: 10000 },
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      accessories,
      pins,
      lineNumber: 12,
      buffer: { plannerBlocks: 15, rxBytes: 120 },
    };
    expect(report.pins?.probe).toBe(true);
    expect(report.feedSpindle?.spindle).toBe(10000);
    expect(report.overrides?.feed).toBe(100);
  });

  it('exposes probe P in PinFlags at the type level', () => {
    expectTypeOf<PinFlags>().toHaveProperty('probe');
    expectTypeOf<PinFlags['probe']>().toEqualTypeOf<boolean | undefined>();
  });

  it('rejects an unknown machine state in a report', () => {
    // @ts-expect-error — 'Boom' is not a MachineState.
    const bad: StatusReport = { state: 'Boom' };
    void bad;
  });

  it('rejects a non-numeric position axis', () => {
    // @ts-expect-error — position axes must be numbers.
    const bad: Position = { x: '1', y: 2, z: 3 };
    void bad;
  });
});
