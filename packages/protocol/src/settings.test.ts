import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  GRBL_SETTING,
  HIGHEST_KNOWN_GRBL_SETTING,
  getMaxTravel,
  getOemSettings,
  getProbeInvert,
  getReportInches,
  getSetting,
  getSoftLimitsEnabled,
  isKnownSettingKey,
  type GrblSettings,
} from './settings.js';

/** A representative Carbide `$$` dump: stock settings plus an OEM `$500`. */
function sampleSettings(): GrblSettings {
  return {
    [GRBL_SETTING.PROBE_INVERT]: 1,
    [GRBL_SETTING.REPORT_INCHES]: 0,
    [GRBL_SETTING.SOFT_LIMITS]: 1,
    [GRBL_SETTING.MAX_TRAVEL_X]: 850,
    [GRBL_SETTING.MAX_TRAVEL_Y]: 850,
    [GRBL_SETTING.MAX_TRAVEL_Z]: 100,
    500: 1, // OEM/Carbide-specific setting above the $132 ceiling.
  };
}

describe('setting keys', () => {
  it('names $6, $13, $20 and $130/$131/$132', () => {
    expect(GRBL_SETTING).toMatchObject({
      PROBE_INVERT: 6,
      REPORT_INCHES: 13,
      SOFT_LIMITS: 20,
      MAX_TRAVEL_X: 130,
      MAX_TRAVEL_Y: 131,
      MAX_TRAVEL_Z: 132,
    });
  });

  it('classifies keys against the stock ceiling', () => {
    expect(HIGHEST_KNOWN_GRBL_SETTING).toBe(132);
    expect(isKnownSettingKey(132)).toBe(true);
    expect(isKnownSettingKey(133)).toBe(false);
    expect(isKnownSettingKey(500)).toBe(false);
  });
});

describe('boolean accessors', () => {
  it('reads $6/$13/$20 as booleans', () => {
    const s = sampleSettings();
    expect(getProbeInvert(s)).toBe(true);
    expect(getReportInches(s)).toBe(false);
    expect(getSoftLimitsEnabled(s)).toBe(true);
  });

  it('treats any non-zero value as true', () => {
    expect(getProbeInvert({ [GRBL_SETTING.PROBE_INVERT]: 7 })).toBe(true);
  });

  it('returns undefined when a setting is absent (no assumed default)', () => {
    expect(getProbeInvert({})).toBeUndefined();
    expect(getReportInches({})).toBeUndefined();
    expect(getSoftLimitsEnabled({})).toBeUndefined();
  });
});

describe('max travel accessor', () => {
  it('reads $130/$131/$132', () => {
    expect(getMaxTravel(sampleSettings())).toEqual({ x: 850, y: 850, z: 100 });
  });

  it('reports undefined per axis when absent', () => {
    expect(getMaxTravel({})).toEqual({ x: undefined, y: undefined, z: undefined });
  });
});

describe('OEM tolerance (edge case: $500)', () => {
  it('keeps unknown settings above $132 and does not throw', () => {
    const s = sampleSettings();
    expect(() => getProbeInvert(s)).not.toThrow();
    // The unknown setting is still present and readable.
    expect(getSetting(s, 500)).toBe(1);
  });

  it('isolates only the OEM settings, leaving stock keys out', () => {
    const oem = getOemSettings(sampleSettings());
    expect(oem).toEqual({ 500: 1 });
    expect(oem[GRBL_SETTING.PROBE_INVERT]).toBeUndefined();
  });

  it('does not mutate the source map', () => {
    const s = sampleSettings();
    const before = { ...s };
    getOemSettings(s);
    expect(s).toEqual(before);
  });
});

describe('type level', () => {
  it('accepts arbitrary numeric keys (tolerant map)', () => {
    expectTypeOf<GrblSettings>().toEqualTypeOf<Record<number, number>>();
    const s: GrblSettings = { 6: 1, 9999: 42 };
    expect(s[9999]).toBe(42);
  });

  it('rejects a non-numeric setting value', () => {
    // @ts-expect-error — GRBL setting values are numbers.
    const bad: GrblSettings = { 6: 'on' };
    void bad;
  });
});
