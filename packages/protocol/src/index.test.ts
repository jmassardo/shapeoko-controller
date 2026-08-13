import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';
import { PROTOCOL_CONTRACT_VERSION } from './index.js';

describe('@shapeoko/protocol barrel', () => {
  it('publishes a semantic contract version', () => {
    expect(PROTOCOL_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('re-exports the machine, settings, panel, and api surfaces', () => {
    // One representative runtime symbol from each module proves the barrel wiring.
    expect(protocol.MACHINE_STATES).toContain('Idle');
    expect(protocol.GRBL_SETTING.PROBE_INVERT).toBe(6);
    expect(protocol.AXIS_SELECTORS).toContain('OFF');
    expect(protocol.REALTIME_COMMAND.JOG_CANCEL).toBe(0x85);
  });
});
