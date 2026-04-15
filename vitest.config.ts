import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    hookTimeout: 30000,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',           // Test files
        'src/domain/interfaces.ts',   // Pure type definitions (no runtime code)
        'src/types/**',               // Type declaration shims
      ],
      thresholds: {
        branches: 85,
        functions: 75,
        lines: 73,
        statements: 73,
      },
    },
  },
});
