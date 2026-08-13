import { describe, expect, it } from 'vitest';

import { SENDER_CORE_READY, senderCorePackageName } from './index.js';

describe('@shapeoko/sender-core smoke', () => {
  it('starts not-ready before any runtime is wired up', () => {
    expect(SENDER_CORE_READY).toBe(false);
  });

  it('reports its package name', () => {
    expect(senderCorePackageName()).toBe('@shapeoko/sender-core');
  });
});
