import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Jev is required, so constructors throw without a key. This placeholder lets the suite
    // run offline; it is not a credential and no test makes a network call.
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/types.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
