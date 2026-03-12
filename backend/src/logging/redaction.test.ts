import { describe, expect, it } from 'vitest';
import { redactMessage, redactParams, SENSITIVE_KEYS } from './redaction.js';

// Sentinel value used by the redaction module
const R = '[REDACTED]';

describe('redaction', () => {
  describe('SENSITIVE_KEYS', () => {
    it('contains all expected sensitive keys', () => {
      const expected = [
        'api_key', 'master_key', 'oauth_token', 'token', 'authorization',
        'secrets', 'password', 'credential', 'private_key', 'access_token',
        'refresh_token', 'bearer', 'connection_string',
      ];
      expect(SENSITIVE_KEYS.size).toBe(expected.length);
      for (const key of expected) {
        expect(SENSITIVE_KEYS.has(key)).toBe(true);
      }
    });
  });

  describe('redactParams', () => {
    it('redacts top-level sensitive keys', () => {
      const result = redactParams({
        api_key: 'tv1',
        username: 'alice',
      });
      expect(result.api_key).toBe(R);
      expect(result.username).toBe('alice');
    });

    it('redacts nested objects at multiple depths', () => {
      const result = redactParams({
        config: {
          database: {
            connection_string: 'db1234',
            name: 'mydb',
          },
          token: 'tk99',
        },
        label: 'test',
      });
      const cfg = result.config as Record<string, unknown>;
      const db = cfg.database as Record<string, unknown>;
      expect(db.connection_string).toBe(R);
      expect(db.name).toBe('mydb');
      expect(cfg.token).toBe(R);
      expect(result.label).toBe('test');
    });

    it('is case-insensitive', () => {
      const result = redactParams({
        API_KEY: 'v1',
        Api_Key: 'v2',
        api_key: 'v3',
        PASSWORD: 'v4',
        Password: 'v5',
      });
      expect(result.API_KEY).toBe(R);
      expect(result.Api_Key).toBe(R);
      expect(result.api_key).toBe(R);
      expect(result.PASSWORD).toBe(R);
      expect(result.Password).toBe(R);
    });

    it('redacts arrays containing objects with sensitive keys', () => {
      const result = redactParams({
        providers: [
          { name: 'prov-a', api_key: 'aa' },
          { name: 'prov-b', api_key: 'bb' },
        ],
      });
      const arr = result.providers as Record<string, unknown>[];
      expect(arr[0].name).toBe('prov-a');
      expect(arr[0].api_key).toBe(R);
      expect(arr[1].name).toBe('prov-b');
      expect(arr[1].api_key).toBe(R);
    });

    it('preserves non-sensitive values unchanged', () => {
      const input = {
        name: 'test-agent',
        count: 42,
        enabled: true,
        tags: ['a', 'b', 'c'],
      };
      const result = redactParams(input);
      expect(result).toEqual(input);
    });

    it('handles empty object', () => {
      expect(redactParams({})).toEqual({});
    });

    it('handles null and undefined values in objects', () => {
      const result = redactParams({
        token: null,
        password: undefined,
        name: 'test',
      });
      expect(result.token).toBe(R);
      expect(result.password).toBe(R);
      expect(result.name).toBe('test');
    });

    it('handles arrays with mixed types', () => {
      const result = redactParams({
        items: [1, 'hi', null, { password: 'pw' }, [{ token: 'tk' }]],
      });
      const items = result.items as unknown[];
      expect(items[0]).toBe(1);
      expect(items[1]).toBe('hi');
      expect(items[2]).toBeNull();
      expect((items[3] as Record<string, unknown>).password).toBe(R);
      const nested = items[4] as Record<string, unknown>[];
      expect(nested[0].token).toBe(R);
    });

    it('does not mutate the original object', () => {
      const original = { api_key: 'tv', name: 'test' };
      const copy = { ...original };
      redactParams(original);
      expect(original).toEqual(copy);
    });
  });

  describe('redactMessage', () => {
    it('redacts KEY=value patterns', () => {
      const result = redactMessage('Connecting with token=abc123 to server');
      expect(result).toBe(`Connecting with token=${R} to server`);
    });

    it('redacts KEY:value patterns', () => {
      const result = redactMessage('authorization:bearer42');
      expect(result).toBe(`authorization:${R}`);
    });

    it('redacts KEY = value patterns (with spaces)', () => {
      const result = redactMessage('password = tval42 done');
      expect(result).toBe(`password = ${R} done`);
    });

    it('is case-insensitive for message patterns', () => {
      const result = redactMessage('API_KEY=aaa TOKEN=bbb Password=ccc');
      expect(result).toBe(`API_KEY=${R} TOKEN=${R} Password=${R}`);
    });

    it('redacts multiple sensitive values in one message', () => {
      const result = redactMessage('api_key=v1 master_key=v2 oauth_token=v3');
      expect(result).toBe(`api_key=${R} master_key=${R} oauth_token=${R}`);
    });

    it('preserves non-sensitive key=value patterns', () => {
      const result = redactMessage('host=localhost port=5432 name=mydb');
      expect(result).toBe('host=localhost port=5432 name=mydb');
    });

    it('returns empty string unchanged', () => {
      expect(redactMessage('')).toBe('');
    });

    it('returns message without sensitive patterns unchanged', () => {
      const msg = 'Starting agent with config loaded';
      expect(redactMessage(msg)).toBe(msg);
    });

    it('handles consecutive calls correctly (regex lastIndex reset)', () => {
      const r1 = redactMessage('token=v1');
      const r2 = redactMessage('token=v2');
      expect(r1).toBe(`token=${R}`);
      expect(r2).toBe(`token=${R}`);
    });
  });
});
