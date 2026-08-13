import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  WCS_IDS,
  WCS_P_WORD,
  getWcsOffset,
  hasWcsOffset,
  isWcsId,
  pWordToWcsId,
  wcsIdToPWord,
  type CoordinateOffsets,
  type CoolantMode,
  type ParserState,
  type WcsId,
  type WcsOffset,
  type WcsPWord,
} from './coordinates.js';
import type { Position } from './machine.js';

/** A fully-populated parser state used as a base for focused assertions. */
const parserState: ParserState = {
  motion: 'G0',
  wcs: 'G54',
  plane: 'G17',
  units: 'G21',
  distance: 'G90',
  arcDistance: 'G91.1',
  feedRateMode: 'G94',
  spindle: 'M5',
  coolant: ['M9'],
  tool: 0,
  feed: 0,
  spindleSpeed: 0,
};

/** Four zeroed fixtures and two unzeroed ones — the production pipeline shape. */
const offsets: CoordinateOffsets = {
  wcs: {
    G54: { x: -100, y: -200, z: -10 },
    G55: { x: -200, y: -200, z: -10 },
    G56: { x: -300, y: -200, z: -10 },
    G57: { x: 0, y: 0, z: 0 },
    G58: null,
    G59: null,
  },
  g28: { x: 0, y: 0, z: 0 },
  g30: { x: 0, y: 0, z: 0 },
  g92: { x: 0, y: 0, z: 0 },
  toolLengthOffset: 0,
};

describe('WcsId', () => {
  it('models exactly the six stock GRBL 1.1 work coordinate systems', () => {
    expect([...WCS_IDS]).toEqual(['G54', 'G55', 'G56', 'G57', 'G58', 'G59']);
    expect(WCS_IDS).toHaveLength(6);
  });

  it('narrows known fixture strings and rejects others', () => {
    expect(isWcsId('G54')).toBe(true);
    expect(isWcsId('G59')).toBe(true);
    expect(isWcsId('G53')).toBe(false);
    expect(isWcsId('G60')).toBe(false);
    expect(isWcsId(54)).toBe(false);
  });

  it('excludes the grblHAL/Mach G59.x extensions at runtime', () => {
    // The Carbide 3D fork is stock GRBL 1.1: G59.1-.3 do not exist on it.
    expect(isWcsId('G59.1')).toBe(false);
    expect(isWcsId('G59.2')).toBe(false);
    expect(isWcsId('G59.3')).toBe(false);
  });

  it('is a closed union of exactly six values at the type level', () => {
    expectTypeOf<WcsId>().toEqualTypeOf<'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59'>();
  });

  it('rejects the G59.x extensions at the type level', () => {
    // @ts-expect-error — 'G59.1' is a grblHAL/Mach extension, not stock GRBL 1.1.
    const bad1: WcsId = 'G59.1';
    void bad1;
    // @ts-expect-error — 'G59.2' is a grblHAL/Mach extension, not stock GRBL 1.1.
    const bad2: WcsId = 'G59.2';
    void bad2;
    // @ts-expect-error — 'G59.3' is a grblHAL/Mach extension, not stock GRBL 1.1.
    const bad3: WcsId = 'G59.3';
    void bad3;
    // @ts-expect-error — 'G53' is the machine coordinate system, not a fixture.
    const bad4: WcsId = 'G53';
    void bad4;
  });
});

describe('WcsId <-> G10 P-word mapping', () => {
  // Exhaustive and explicit: an off-by-one here writes an offset into the wrong
  // fixture, which in the four-fixture pipeline means cutting the wrong part.
  const expectedPairs: ReadonlyArray<readonly [WcsId, WcsPWord]> = [
    ['G54', 1],
    ['G55', 2],
    ['G56', 3],
    ['G57', 4],
    ['G58', 5],
    ['G59', 6],
  ];

  it('maps P1=G54 through P6=G59', () => {
    expect(WCS_P_WORD).toEqual({ G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 });
  });

  it.each(expectedPairs)('wcsIdToPWord(%s) === %i', (wcs, p) => {
    expect(wcsIdToPWord(wcs)).toBe(p);
  });

  it.each(expectedPairs)('pWordToWcsId(%2$i) === %1$s', (wcs, p) => {
    expect(pWordToWcsId(p)).toBe(wcs);
  });

  it('round-trips every fixture in both directions', () => {
    for (const wcs of WCS_IDS) {
      expect(pWordToWcsId(wcsIdToPWord(wcs))).toBe(wcs);
    }
    for (const p of [1, 2, 3, 4, 5, 6] as const) {
      const wcs = pWordToWcsId(p);
      expect(wcs).toBeDefined();
      expect(wcsIdToPWord(wcs as WcsId)).toBe(p);
    }
  });

  it('covers every fixture exactly once, with no duplicate P words', () => {
    const pWords = WCS_IDS.map(wcsIdToPWord);
    expect(new Set(pWords).size).toBe(WCS_IDS.length);
    expect(Object.keys(WCS_P_WORD).sort()).toEqual([...WCS_IDS].sort());
  });

  it('returns undefined for out-of-range P words rather than defaulting', () => {
    expect(pWordToWcsId(0)).toBeUndefined();
    expect(pWordToWcsId(7)).toBeUndefined();
    expect(pWordToWcsId(-1)).toBeUndefined();
    expect(pWordToWcsId(1.5)).toBeUndefined();
    expect(pWordToWcsId(Number.NaN)).toBeUndefined();
  });

  it('constrains the P word to 1-6 at the type level', () => {
    expectTypeOf<WcsPWord>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6>();
    expectTypeOf(wcsIdToPWord).returns.toEqualTypeOf<WcsPWord>();
    expectTypeOf(pWordToWcsId).returns.toEqualTypeOf<WcsId | undefined>();
    // @ts-expect-error — 7 is not a valid G10 P word.
    const bad: WcsPWord = 7;
    void bad;
    // @ts-expect-error — wcsIdToPWord only accepts a WcsId.
    wcsIdToPWord('G59.1');
  });
});

describe('ParserState', () => {
  it('carries the active WCS, which the ? status report does not', () => {
    expect(parserState.wcs).toBe('G54');
    expectTypeOf<ParserState['wcs']>().toEqualTypeOf<WcsId>();
  });

  it('models the modal groups #81 and #151 must save and restore', () => {
    const restored: ParserState = { ...parserState, wcs: 'G57', units: 'G20', distance: 'G91' };
    expect(restored.wcs).toBe('G57');
    expect(restored.units).toBe('G20');
    expect(restored.distance).toBe('G91');
    expect(restored.motion).toBe('G0');
    expect(restored.feedRateMode).toBe('G94');
  });

  it('models the G38.x probe motion modes', () => {
    const probing: ParserState = { ...parserState, motion: 'G38.2' };
    expect(probing.motion).toBe('G38.2');
  });

  it('allows mist and flood coolant to be latched together', () => {
    const both: ParserState = { ...parserState, coolant: ['M7', 'M8'] };
    expect(both.coolant).toEqual(['M7', 'M8']);
    expectTypeOf<ParserState['coolant']>().toEqualTypeOf<readonly CoolantMode[]>();
  });

  it('treats program flow and spindle speed as optional, everything else required', () => {
    const withoutSpindleSpeed: ParserState = {
      motion: 'G0',
      wcs: 'G54',
      plane: 'G17',
      units: 'G21',
      distance: 'G90',
      arcDistance: 'G91.1',
      feedRateMode: 'G94',
      spindle: 'M5',
      coolant: ['M9'],
      tool: 0,
      feed: 0,
    };
    const minimal: ParserState = withoutSpindleSpeed;
    expect(minimal.spindleSpeed).toBeUndefined();
    expect(minimal.program).toBeUndefined();
    expectTypeOf<ParserState['spindleSpeed']>().toEqualTypeOf<number | undefined>();
    // @ts-expect-error — the active WCS is required; a parser state without it is invalid.
    const bad: ParserState = { ...withoutSpindleSpeed, wcs: undefined };
    void bad;
  });

  it('rejects an unsupported modal word at the type level', () => {
    // @ts-expect-error — 'G22' is not a units mode.
    const badUnits: ParserState = { ...parserState, units: 'G22' };
    void badUnits;
    // @ts-expect-error — 'G59.1' is not a supported work coordinate system.
    const badWcs: ParserState = { ...parserState, wcs: 'G59.1' };
    void badWcs;
  });
});

describe('CoordinateOffsets', () => {
  it('keys the six fixture offsets by WcsId for direct lookup', () => {
    expect(Object.keys(offsets.wcs).sort()).toEqual([...WCS_IDS].sort());
    expect(getWcsOffset(offsets, 'G56')).toEqual({ x: -300, y: -200, z: -10 });
    expectTypeOf<CoordinateOffsets['wcs']>().toEqualTypeOf<Readonly<Record<WcsId, WcsOffset>>>();
  });

  it('distinguishes an unzeroed fixture from one zeroed at the origin', () => {
    // G57 is deliberately zeroed AT the machine origin; G58 has never been zeroed.
    // #34 must refuse a job on G58 while allowing one on G57, so these must not collapse.
    expect(getWcsOffset(offsets, 'G57')).toEqual({ x: 0, y: 0, z: 0 });
    expect(getWcsOffset(offsets, 'G58')).toBeNull();
    expect(hasWcsOffset(offsets, 'G57')).toBe(true);
    expect(hasWcsOffset(offsets, 'G58')).toBe(false);
    expect(hasWcsOffset(offsets, 'G59')).toBe(false);
  });

  it('reports which of the four pipeline fixtures are ready', () => {
    const ready = WCS_IDS.filter((wcs) => hasWcsOffset(offsets, wcs));
    expect(ready).toEqual(['G54', 'G55', 'G56', 'G57']);
  });

  it('models G28, G30, G92 and the scalar TLO', () => {
    expect(offsets.g28).toEqual({ x: 0, y: 0, z: 0 });
    expect(offsets.g30).toEqual({ x: 0, y: 0, z: 0 });
    // G92 is modelled because GRBL reports it; this project never ISSUES it.
    expect(offsets.g92).toEqual({ x: 0, y: 0, z: 0 });
    expectTypeOf<CoordinateOffsets['toolLengthOffset']>().toEqualTypeOf<number>();
  });

  it('lets a consumer see a stale non-zero G92 left behind by another tool', () => {
    const stale: CoordinateOffsets = { ...offsets, g92: { x: 5, y: 0, z: 0 } };
    expect(stale.g92.x).toBe(5);
  });

  it('reuses the shared Position type for offset triples', () => {
    expectTypeOf<CoordinateOffsets['g28']>().toEqualTypeOf<Position>();
    expectTypeOf<WcsOffset>().toEqualTypeOf<Position | null>();
  });

  it('requires every fixture key so a lookup is never silently undefined', () => {
    // @ts-expect-error — G59 is missing; all six fixtures must be present.
    const bad: CoordinateOffsets['wcs'] = {
      G54: null,
      G55: null,
      G56: null,
      G57: null,
      G58: null,
    };
    void bad;
  });

  it('rejects undefined as a stand-in for an unzeroed fixture', () => {
    // Absence is spelled `null`, explicitly — not `undefined`, which would be
    // indistinguishable from a missing key.
    // @ts-expect-error — an unknown offset must be null, not undefined.
    const bad: WcsOffset = undefined;
    void bad;
  });

  it('rejects the TLO being modelled as a triple', () => {
    // @ts-expect-error — GRBL reports TLO as a single Z scalar.
    const bad: CoordinateOffsets = { ...offsets, toolLengthOffset: { x: 0, y: 0, z: 1 } };
    void bad;
  });
});
