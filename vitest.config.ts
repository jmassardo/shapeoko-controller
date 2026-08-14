import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'protocol',
          root: 'packages/protocol',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'sender-core',
          root: 'packages/sender-core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        esbuild: {
          jsx: 'automatic',
          jsxImportSource: 'react',
        },
        test: {
          name: 'ui',
          root: 'packages/ui',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
