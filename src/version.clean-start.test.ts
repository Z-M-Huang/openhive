import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('version clean start', () => {
  it('package.json version should be 4.6.3', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(pkg.version).toBe('4.6.3');
  });

  it('README.md title should reference v4.6.3', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    const firstLine = readme.split('\n')[0];
    expect(firstLine).toContain('OpenHive v4.6.3');
  });

  it('README.md should not have "v4 Changes from v3" section', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    expect(readme).not.toContain('Changes from v3');
  });

  it('src/index.ts header comment should reference v4.6.3', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    const firstLine = index.split('\n')[0];
    expect(firstLine).toContain('OpenHive v4.6.3');
  });

  it('src/index.ts startup log should contain 4.6.3', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    expect(index).toContain('OpenHive v4.6.3 started');
    expect(index).not.toContain('v4.6.0');
    expect(index).not.toContain('v4.6.1');
    expect(index).not.toContain('v4.6.2');
    expect(index).not.toContain('v0.5.');
  });

  it('no stale version references in package.json, README.md, or src/index.ts', () => {
    const files = ['package.json', 'README.md', 'src/index.ts'];
    const stalePatterns = ['4.6.1', '4.6.2', '0.5.0', '0.5.1', 'Changes from v3'];

    for (const file of files) {
      const filePath = path.join(__dirname, '..', file);
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const pattern of stalePatterns) {
        expect(content, `${file} should not contain "${pattern}"`).not.toContain(pattern);
      }
    }
  });

  it('package.json should not carry a stale version string', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(pkg.version).not.toBe('4.6.1');
    expect(pkg.version).not.toBe('4.6.2');
    expect(pkg.version).not.toBe('0.5.1');
    expect(pkg.version).not.toContain('v3');
  });

  it('README.md title should not contain v3', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    const titleMatch = readme.match(/^#\s+.*/m);
    expect(titleMatch).toBeTruthy();
    const title = titleMatch![0];
    expect(title).not.toMatch(/v3\b/);
  });

  it('src/index.ts header comment should not contain v3', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    const headerMatch = index.match(/^\/\*\*.+\*\//);
    expect(headerMatch).toBeTruthy();
    const header = headerMatch![0];
    expect(header).not.toMatch(/v3\b/);
  });

  it('src/index.ts startup log should not reference v3 or v0.5', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const index = fs.readFileSync(indexPath, 'utf-8');
    const startupLogMatch = index.match(/logger\.info\('OpenHive[^']+',/);
    expect(startupLogMatch).toBeTruthy();
    const startupLog = startupLogMatch![0];
    expect(startupLog).not.toMatch(/v3\b/);
    expect(startupLog).not.toContain('0.5.');
    expect(startupLog).toContain('4.6.3');
  });
});
