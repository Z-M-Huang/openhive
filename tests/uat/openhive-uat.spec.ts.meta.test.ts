// tests: tests/uat/openhive-uat.spec.ts.meta.test.ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('UAT harness scaffolding', () => {
  it('enumerates exactly 28 UAT blocks named UAT-1 through UAT-28', () => {
    const spec = readFileSync('tests/uat/openhive-uat.spec.ts', 'utf8');
    const ids = (spec.match(/UAT-\d+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i).sort();
    expect(ids.length).toBe(28);
    expect(ids).toContain('UAT-1');
    expect(ids).toContain('UAT-28');
  });

  it('has no remaining test.skip blocks (all units have landed)', () => {
    const spec = readFileSync('tests/uat/openhive-uat.spec.ts', 'utf8');
    const skipCount = (spec.match(/test\.skip\(/g) ?? []).length;
    expect(skipCount).toBe(0);
  });

  it('registers the test:uat script in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['test:uat']).toBe('playwright test tests/uat/openhive-uat.spec.ts');
  });

  it('adds @playwright/test to devDependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(typeof pkg.devDependencies['@playwright/test']).toBe('string');
  });

  it('creates the spec file at the canonical path', () => {
    expect(existsSync('tests/uat/openhive-uat.spec.ts')).toBe(true);
  });
});
