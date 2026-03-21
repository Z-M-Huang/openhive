/**
 * Tests for MCP tools helper functions: resolveSecretsTemplate, resolveSecretsTemplatesInObject.
 *
 * @module mcp/tools/helpers.test
 */

import { describe, it, expect } from 'vitest';
import { resolveSecretsTemplate, resolveSecretsTemplatesInObject } from './index.js';

describe('resolveSecretsTemplate', () => {
  it('resolves {secrets.KEY} placeholders', () => {
    const secrets = { VAR1: 'value_abc', VAR2: 'value_xyz' };
    const result = resolveSecretsTemplate('url?a={secrets.VAR1}&b={secrets.VAR2}', secrets);
    expect(result).toBe('url?a=value_abc&b=value_xyz');
  });

  it('leaves unresolved placeholders unchanged', () => {
    const secrets = { VAR1: 'value1' };
    const result = resolveSecretsTemplate('{secrets.VAR1} and {secrets.MISSING}', secrets);
    expect(result).toBe('value1 and {secrets.MISSING}');
  });

  it('returns unchanged string when no placeholders', () => {
    const secrets = { VAR1: 'value1' };
    const result = resolveSecretsTemplate('no placeholders here', secrets);
    expect(result).toBe('no placeholders here');
  });

  it('handles empty secrets object', () => {
    const result = resolveSecretsTemplate('{secrets.VAR1}', {});
    expect(result).toBe('{secrets.VAR1}');
  });

  it('handles multiple occurrences of same key', () => {
    const secrets = { KEY: 'value' };
    const result = resolveSecretsTemplate('{secrets.KEY}-{secrets.KEY}', secrets);
    expect(result).toBe('value-value');
  });
});

describe('resolveSecretsTemplatesInObject', () => {
  it('resolves templates in string values', () => {
    const secrets = { HOST: 'example.com', PORT: '8080' };
    const obj = { url: 'https://{secrets.HOST}:{secrets.PORT}' };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ url: 'https://example.com:8080' });
  });

  it('recursively resolves in nested objects', () => {
    const secrets = { KEY: 'value1' };
    const obj = { level1: { level2: { value: '{secrets.KEY}' } } };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ level1: { level2: { value: 'value1' } } });
  });

  it('resolves templates in arrays', () => {
    const secrets = { ITEM: 'replaced' };
    const obj = { items: ['{secrets.ITEM}', 'static', '{secrets.ITEM}'] };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ items: ['replaced', 'static', 'replaced'] });
  });

  it('preserves non-string types', () => {
    const secrets = { KEY: 'value' };
    const obj = { num: 42, bool: true, nil: null, str: '{secrets.KEY}' };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ num: 42, bool: true, nil: null, str: 'value' });
  });

  it('handles null and undefined values', () => {
    const secrets = { KEY: 'value' };
    const obj = { a: null, b: undefined };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ a: null, b: undefined });
  });
});

