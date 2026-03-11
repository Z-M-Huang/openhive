import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/test/**",
      ],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "src/domain/**": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
        "src/control-plane/**": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
        "src/executor/**": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
        "src/storage/**": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
