import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('health clean start', () => {
  const filesToCheck = [
    'src/health.ts',
    'src/domain/types.ts',
    'src/domain/interfaces.ts',
    'src/domain/errors.ts',
    'src/storage/database.ts',
    'src/storage/schema.ts',
  ];

  it('no header should contain v3, v4, or 4.x in checked files', () => {
    for (const file of filesToCheck) {
      const filePath = path.join(__dirname, '..', file);
      const content = fs.readFileSync(filePath, 'utf-8');
      // Check for legacy version patterns in the header comment
      const headerMatch = content.match(/^\/\*\*[\s\S]*?\*\//);
      expect(headerMatch, `${file} should have a header comment`).toBeTruthy();
      const header = headerMatch![0];
      expect(header, `${file} header should not contain v3`).not.toMatch(/v3\b/);
      expect(header, `${file} header should not contain v4`).not.toMatch(/v4\b/);
      expect(header, `${file} header should not contain 4.x pattern`).not.toMatch(/4\.[0-9]/);
    }
  });

  it('headers should reference v0.5.0', () => {
    for (const file of filesToCheck) {
      const filePath = path.join(__dirname, '..', file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const headerMatch = content.match(/^\/\*\*[\s\S]*?\*\//);
      expect(headerMatch, `${file} should have a header comment`).toBeTruthy();
      const header = headerMatch![0];
      expect(header, `${file} header should contain v0.5.0`).toContain('v0.5.0');
    }
  });

  it('health endpoint response should not contain legacy version patterns', async () => {
    // This test validates the interface contract that if /health exposes a version,
    // it must be 0.5.0 and not v3/v4/4.x
    // The actual health response structure is tested in health.test.ts
    // This test ensures clean start by checking source files
    const healthPath = path.join(__dirname, 'health.ts');
    const content = fs.readFileSync(healthPath, 'utf-8');
    
    // Check that no legacy version patterns exist in the file
    expect(content, 'health.ts should not contain v3 version').not.toMatch(/v3\b/);
    expect(content, 'health.ts should not contain v4 version').not.toMatch(/v4\b/);
    expect(content, 'health.ts should not contain 4.x pattern').not.toMatch(/4\.[0-9]/);
  });
});