/**
 * GRBL settings contract for the Shapeoko controller.
 *
 * Models the `$$` settings block of the Carbide 3D GRBL 1.1 fork as a tolerant,
 * numeric-keyed map plus tiny pure accessors for the specific settings this
 * project reads. PURE data + helpers only — no serial I/O, no parsing of the
 * live `$$` response (that lives in sender-core, issue #26), no runtime
 * dependencies.
 *
 * TOLERANCE IS LOAD-BEARING. The Carbide fork is closed-source and ships OEM
 * settings above the stock GRBL `$132` ceiling (e.g. `$500=`). Those unknown
 * settings MUST be stored and round-tripped untouched — never dropped, never
 * thrown on (protocol doc §5.4 and the summary table). {@link GrblSettings}
 * therefore keys on an arbitrary number, and the accessors below read only the
 * settings they name, ignoring everything else.
 */

/**
 * A GRBL settings map: setting number → raw numeric value, exactly as `$$`
 * reports it (`$N=value`). Stock GRBL 1.1 defines `$0`–`$132`; the Carbide fork
 * adds OEM keys above that. All keys — known and unknown — live here together so
 * a read/modify/write cycle preserves OEM settings verbatim.
 *
 * Values are stored as `number` because every GRBL setting is transmitted as a
 * decimal (booleans are `0`/`1`, masks are integers, distances/rates are
 * floats). Interpreting a value as a flag or a distance is the accessors' job.
 */
export type GrblSettings = Record<number, number>;

/**
 * The highest stock GRBL 1.1 setting number. Any key strictly greater than this
 * is an OEM/Carbide-specific setting that this project does not interpret but
 * MUST preserve.
 *
 * UNVERIFIED (#17): the exact set of Carbide OEM settings above `$132` (their
 * numbers, meanings, and whether the BitSetter XY location is stored among them)
 * is not documented — the fork source is unavailable. This ceiling is the seam:
 * treat everything above it as opaque-but-preserved until #17 captures the real
 * `$$` dump from hardware. Do NOT add named accessors for `> 132` keys here
 * until then.
 */
export const HIGHEST_KNOWN_GRBL_SETTING = 132;

/**
 * Named setting numbers this project reads. Kept as a const map so call sites
 * reference `GRBL_SETTING.PROBE_INVERT` rather than a bare `6`.
 *
 * Only the settings the sender actually consumes are named here (protocol doc
 * §5.4 / implementation checklist step 1: cache `$6`, `$13`, `$20`, `$130`–
 * `$132`). This is deliberately not an exhaustive GRBL settings enum.
 */
export const GRBL_SETTING = {
  /** `$6` — probe pin invert (boolean flag). */
  PROBE_INVERT: 6,
  /** `$13` — report inches (boolean flag). */
  REPORT_INCHES: 13,
  /** `$20` — soft limits enable (boolean flag). */
  SOFT_LIMITS: 20,
  /** `$130` — X max travel (mm). */
  MAX_TRAVEL_X: 130,
  /** `$131` — Y max travel (mm). */
  MAX_TRAVEL_Y: 131,
  /** `$132` — Z max travel (mm). */
  MAX_TRAVEL_Z: 132,
} as const;

/**
 * Read a raw setting value, or `undefined` if the setting is absent. The base
 * accessor all others build on; it never assumes a default.
 */
export function getSetting(settings: GrblSettings, key: number): number | undefined {
  return settings[key];
}

/** True if `key` is a stock GRBL setting (`<= $132`), false if it is OEM/unknown. */
export function isKnownSettingKey(key: number): boolean {
  return key <= HIGHEST_KNOWN_GRBL_SETTING;
}

/**
 * OEM/Carbide-specific settings above the stock GRBL ceiling, preserved as-is.
 * Returns a new map containing only keys `> $132`; the original is not mutated.
 * Use this to prove that a round-trip kept OEM settings (e.g. `$500=`) — see the
 * `$500` edge case in the acceptance criteria.
 *
 * UNVERIFIED (#17): what these keys mean is unknown; this helper deliberately
 * does not interpret them, only isolates them for preservation.
 */
export function getOemSettings(settings: GrblSettings): GrblSettings {
  const oem: GrblSettings = {};
  for (const rawKey of Object.keys(settings)) {
    const key = Number(rawKey);
    if (!isKnownSettingKey(key)) {
      // Non-null assertion is safe: `key` came from Object.keys(settings).
      oem[key] = settings[key]!;
    }
  }
  return oem;
}

/**
 * Interpret a GRBL boolean setting. GRBL stores flags as `0`/`1`; any non-zero
 * value is treated as true. Returns `undefined` when the setting is absent so a
 * caller can distinguish "off" from "not reported yet" — the sender must not
 * assume a default for an unread setting (protocol doc §5.4).
 */
function readBooleanSetting(settings: GrblSettings, key: number): boolean | undefined {
  const value = settings[key];
  return value === undefined ? undefined : value !== 0;
}

/**
 * `$6` — probe pin invert.
 *
 * UNVERIFIED (#20): the default probe-pin polarity on the Carbide 3D board is
 * not documented. This accessor reads the reported value and returns
 * `undefined` when `$6` is absent rather than guessing a default — that
 * `undefined` is the seam. Callers must read the real `$6` from `$$` (or test
 * empirically per the summary table) before relying on probe polarity, and must
 * not hard-code an assumed default until #20 confirms it against hardware.
 */
export function getProbeInvert(settings: GrblSettings): boolean | undefined {
  return readBooleanSetting(settings, GRBL_SETTING.PROBE_INVERT);
}

/** `$13` — report inches. `undefined` when `$13` is absent. */
export function getReportInches(settings: GrblSettings): boolean | undefined {
  return readBooleanSetting(settings, GRBL_SETTING.REPORT_INCHES);
}

/** `$20` — soft limits enabled. `undefined` when `$20` is absent. */
export function getSoftLimitsEnabled(settings: GrblSettings): boolean | undefined {
  return readBooleanSetting(settings, GRBL_SETTING.SOFT_LIMITS);
}

/**
 * `$130`/`$131`/`$132` — per-axis maximum travel in millimetres. Each axis is
 * `undefined` when its setting is absent. Used to bound probe moves safely
 * against soft limits, e.g. `maxProbeZ = $132 - |currentMcsZ| - margin`
 * (protocol doc §4.2).
 */
export function getMaxTravel(settings: GrblSettings): {
  x: number | undefined;
  y: number | undefined;
  z: number | undefined;
} {
  return {
    x: settings[GRBL_SETTING.MAX_TRAVEL_X],
    y: settings[GRBL_SETTING.MAX_TRAVEL_Y],
    z: settings[GRBL_SETTING.MAX_TRAVEL_Z],
  };
}
