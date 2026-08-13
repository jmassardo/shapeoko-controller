import { describe, expect, it } from 'vitest';

import { PROTOCOL_CONTRACT_VERSION, protocolPackageName } from './index.js';

describe('@shapeoko/protocol smoke', () => {
  it('exposes a contract version placeholder', () => {
    expect(PROTOCOL_CONTRACT_VERSION).toBe('0.0.0');
  });

  it('reports its package name', () => {
    expect(protocolPackageName()).toBe('@shapeoko/protocol');
  });
});
