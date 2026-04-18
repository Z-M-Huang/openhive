import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('version clean start', () => {
  it('package.json version should be 0.5.1', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(pkg.version).toBe('0.5.1');
  });

  it('README.md should not reference v4 or v3 in title', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    const firstLine = readme.split('\n')[0];
    expect(firstLine).toContain('OpenHive v0.5.1');
    expect(firstLine).not.toContain('v4');
    expect(firstLine).not.toContain('v3');
  });

  it('README.md should not have "v4 Changes from v3" section', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    expect(readme).not.toContain('Changes from v3');
  });

  it('src/index.ts header comment should reference v0.5.1', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    const firstLine = index.split('\n')[0];
    expect(firstLine).toContain('OpenHive v0.5.1');
    expect(firstLine).not.toContain('v4');
    expect(firstLine).not.toContain('v3');
  });

  it('src/index.ts startup log should contain 0.5.1', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    expect(index).toContain('OpenHive v0.5.1 started');
    expect(index).not.toContain('v4.6.0');
    expect(index).not.toContain('v4.6.1');
  });

  it('no legacy version references (4.6.1, Changes from v3) in package.json, README.md, or src/index.ts', () => {
    const files = ['package.json', 'README.md', 'src/index.ts'];
    // Only check for specific legacy version patterns
    const legacyPatterns = ['4.6.1', 'Changes from v3'];

    for (const file of files) {
      const filePath = path.join(__dirname, '..', file);
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const pattern of legacyPatterns) {
        expect(content, `${file} should not contain "${pattern}"`).not.toContain(pattern);
      }
    }
  });

  it('package.json should not have v4 version string', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(pkg.version).not.toBe('4.6.1');
    expect(pkg.version).not.toContain('v4');
  });

  it('README.md should not have v4 in title (explicit check)', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    const titleMatch = readme.match(/^#\s+.*/m);
    expect(titleMatch).toBeTruthy();
    const title = titleMatch![0];
    expect(title).not.toMatch(/v4\b/);
    expect(title).not.toMatch(/v3\b/);
  });

  it('src/index.ts should not have v4 or v3 in header comment (explicit check)', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    const headerMatch = index.match(/^\/\*\*.+\*\//);
    expect(headerMatch).toBeTruthy();
    const header = headerMatch![0];
    expect(header).not.toMatch(/v4\b/);
    expect(header).not.toMatch(/v3\b/);
  });

  it('src/index.ts startup log should not reference v4 or v3', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    // Match the startup log line specifically
    const startupLogMatch = index.match(/logger\.info\('OpenHive[^']+',/);
    expect(startupLogMatch).toBeTruthy();
    const startupLog = startupLogMatch![0];
    expect(startupLog).not.toMatch(/v4\b/);
    expect(startupLog).not.toMatch(/v3\b/);
    expect(startupLog).toContain('0.5.1');
  });
});