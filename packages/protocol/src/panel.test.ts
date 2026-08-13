import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AXIS_SELECTORS,
  PANEL_BUTTONS,
  PANEL_LEDS,
  STEP_MULTIPLIERS,
  STEP_MULTIPLIER_MM,
  stepMultiplierToMillimeters,
  type AxisSelector,
  type PanelButtonId,
  type PanelFrame,
  type PanelLedId,
  type StepMultiplier,
} from './panel.js';

describe('axis selector', () => {
  it('has values OFF / X / Y / Z', () => {
    expect([...AXIS_SELECTORS]).toEqual(['OFF', 'X', 'Y', 'Z']);
  });

  it('rejects an unsupported axis at the type level', () => {
    // @ts-expect-error — 'A' is not a panel axis selector.
    const bad: AxisSelector = 'A';
    void bad;
  });
});

describe('step multiplier', () => {
  it('maps 1 -> 0.001, 10 -> 0.01, 100 -> 0.1 mm', () => {
    expect(STEP_MULTIPLIER_MM).toEqual({ 1: 0.001, 10: 0.01, 100: 0.1 });
    expect(stepMultiplierToMillimeters(1)).toBe(0.001);
    expect(stepMultiplierToMillimeters(10)).toBe(0.01);
    expect(stepMultiplierToMillimeters(100)).toBe(0.1);
  });

  it('enumerates exactly x1 / x10 / x100', () => {
    expect([...STEP_MULTIPLIERS]).toEqual([1, 10, 100]);
  });

  it('rejects an unsupported step multiplier at the type level', () => {
    // @ts-expect-error — 50 is not a valid step multiplier.
    const bad: StepMultiplier = 50;
    void bad;
    // @ts-expect-error — stepMultiplierToMillimeters only accepts 1 | 10 | 100.
    stepMultiplierToMillimeters(1000);
  });
});

describe('control ids match the panel spec', () => {
  it('lists the buttons from hardware/panel-spec.yaml', () => {
    expect([...PANEL_BUTTONS]).toEqual([
      'estop',
      'start',
      'hold',
      'reset',
      'enable',
      'spindle',
      'dust',
    ]);
  });

  it('lists the LED indicators from hardware/panel-spec.yaml', () => {
    expect([...PANEL_LEDS]).toEqual(['led_pwr', 'led_link', 'led_homed', 'led_alarm', 'led_probe']);
  });

  it('rejects an unknown button or LED id', () => {
    // @ts-expect-error — 'jog' is not a panel button id.
    const badButton: PanelButtonId = 'jog';
    void badButton;
    // @ts-expect-error — 'led_wifi' is not a panel LED id.
    const badLed: PanelLedId = 'led_wifi';
    void badLed;
  });
});

describe('panel frames', () => {
  it('are a discriminated union on type', () => {
    const frames: PanelFrame[] = [
      { type: 'button', button: 'start', edge: 'down' },
      { type: 'axis', axis: 'X' },
      { type: 'step', step: 100 },
      { type: 'mpg', delta: -3 },
      { type: 'pot', pot: 'feed_override', value: 0.5 },
      { type: 'led', led: 'led_probe', state: 'blink' },
    ];
    expect(frames).toHaveLength(6);
  });

  it('narrows on the discriminant', () => {
    const frame: PanelFrame = { type: 'axis', axis: 'Z' };
    if (frame.type === 'axis') {
      expectTypeOf(frame.axis).toEqualTypeOf<AxisSelector>();
      expect(frame.axis).toBe('Z');
    }
  });

  it('rejects a frame with an unknown discriminant', () => {
    // @ts-expect-error — 'buzzer' is not a panel frame type.
    const bad: PanelFrame = { type: 'buzzer' };
    void bad;
  });

  it('rejects a button frame carrying an unknown button', () => {
    // @ts-expect-error — 'launch' is not a panel button id.
    const bad: PanelFrame = { type: 'button', button: 'launch', edge: 'down' };
    void bad;
  });
});
