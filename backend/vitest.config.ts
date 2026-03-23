import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',           // Test files
        'src/phase-gates/**',         // Phase gate test files
        'src/domain/interfaces.ts',   // Pure type definitions (no runtime code)
        'src/types/**',               // Type declaration shims
      ],
      thresholds: {
        branches: 85,
        functions: 93,
        lines: 93,
        statements: 93,
      },
    },
  },
});
