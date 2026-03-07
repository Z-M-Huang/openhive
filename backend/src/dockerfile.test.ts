/**
 * Dockerfile structural tests (step 61).
 *
 * Validates the master Dockerfile structure without running a Docker build.
 * Verifies that the Go builder stage was removed, a TypeScript backend
 * builder stage was added, only compiled JS reaches the final stage, and
 * the entry point uses Node.js.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/src/ → backend/ → openhive/ → deployments/Dockerfile
const DOCKERFILE_PATH = resolve(__dirname, '../..', 'deployments', 'Dockerfile');

let content: string;

beforeAll(() => {
  content = readFileSync(DOCKERFILE_PATH, 'utf-8');
});

describe('Dockerfile (master) — structural validation', () => {
  it('Dockerfile builds successfully: contains a backend-builder stage', () => {
    expect(content).toContain('AS backend-builder');
  });

  it('Dockerfile does not contain the Go builder stage', () => {
    expect(content).not.toContain('golang:');
    expect(content).not.toContain('go build');
    expect(content).not.toContain('AS go-builder');
  });

  it('Built image contains compiled backend JS: dist/ copied from builder', () => {
    expect(content).toContain('--from=backend-builder');
    expect(content).toContain('backend/dist');
  });

  it('Built image does not contain TypeScript source: COPY backend/src never in final stage', () => {
    // Only check COPY instructions in the final stage (lines after the last FROM).
    // Builder stages legitimately copy src/ for compilation.
    const lines = content.split('\n');
    let lastFromIndex = 0;
    lines.forEach((line, i) => {
      if (line.trim().startsWith('FROM')) {
        lastFromIndex = i;
      }
    });
    const finalStageLines = lines.slice(lastFromIndex);
    const copyInFinal = finalStageLines.filter(
      (line) => line.trim().startsWith('COPY') && !line.includes('--from='),
    );
    const srcLeaks = copyInFinal.some((line) => line.includes('backend/src'));
    expect(srcLeaks).toBe(false);
  });

  it('Entry point starts Node.js backend', () => {
    expect(content).toContain('ENTRYPOINT ["node", "backend/dist/index.js"]');
    expect(content).not.toContain('ENTRYPOINT ["/usr/local/bin/openhive"]');
  });

  it('Final stage extends openhive-team', () => {
    const fromFinal = content
      .split('\n')
      .filter((line) => line.trim().startsWith('FROM') && !line.includes(' AS '));
    expect(fromFinal.some((l) => l.includes('openhive-team'))).toBe(true);
  });
});
