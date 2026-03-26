/**
 * UT-17: Trigger Handlers (Schedule, Keyword, Message)
 *
 * Tests:
 * - Schedule handler starts/stops, fires callback
 * - Keyword handler matches/doesn't match (plain, regex, special chars)
 * - Message handler matches with channel filter
 */

import { describe, it, expect, vi } from 'vitest';

import { ScheduleHandler } from './handlers/schedule.js';
import { KeywordHandler } from './handlers/keyword.js';
import { MessageHandler } from './handlers/message.js';

// ── UT-17: Schedule Handler ─────────────────────────────────────────────

describe('UT-17: Schedule Handler', () => {
  it('start and stop lifecycle works', () => {
    const cb = vi.fn();
    // Use far-future cron so it never fires during the test
    const handler = new ScheduleHandler('0 0 1 1 *', cb);

    handler.start();
    // Verify the handler accepted the cron without error
    expect(cb).not.toHaveBeenCalled();
    handler.stop();
  });

  it('stop prevents further firing and double-stop is safe', () => {
    const cb = vi.fn();
    const handler = new ScheduleHandler('0 0 1 1 *', cb);
    handler.start();
    handler.stop();
    // Double stop is safe
    handler.stop();
    expect(cb).not.toHaveBeenCalled();
  });

  it('start creates a cron task that invokes callback', async () => {
    const cb = vi.fn();
    const handler = new ScheduleHandler('* * * * * *', cb);
    handler.start();

    // Wait slightly over 1 second for the per-second cron to fire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(cb).toHaveBeenCalled();
    handler.stop();
  });
});

// ── UT-17: Keyword Handler ───────────────────────────────────────────────

describe('UT-17: Keyword Handler', () => {
  it('matches plain keyword (case-insensitive)', () => {
    const cb = vi.fn();
    const handler = new KeywordHandler('deploy', cb);

    expect(handler.match('Please deploy the app')).toBe(true);
    expect(handler.match('DEPLOY now')).toBe(true);
    expect(handler.match('something else')).toBe(false);
  });

  it('matches regex pattern', () => {
    const cb = vi.fn();
    const handler = new KeywordHandler('/deploy\\s+v\\d+/i', cb);

    expect(handler.match('deploy v2')).toBe(true);
    expect(handler.match('Deploy V3')).toBe(true);
    expect(handler.match('deploy')).toBe(false);
  });

  it('escapes special regex chars in plain keywords', () => {
    const cb = vi.fn();
    const handler = new KeywordHandler('price: $10.00', cb);

    expect(handler.match('The price: $10.00 is final')).toBe(true);
    expect(handler.match('price: 910a00')).toBe(false);
  });
});

// ── UT-17: Message Handler ───────────────────────────────────────────────

describe('UT-17: Message Handler', () => {
  it('matches regex pattern', () => {
    const cb = vi.fn();
    const handler = new MessageHandler('error\\s+\\d{3}', undefined, cb);

    expect(handler.match('got error 500 today')).toBe(true);
    expect(handler.match('all good')).toBe(false);
  });

  it('respects channel filter', () => {
    const cb = vi.fn();
    const handler = new MessageHandler('alert', 'ops-channel', cb);

    expect(handler.match('alert: fire', 'ops-channel')).toBe(true);
    expect(handler.match('alert: fire', 'general')).toBe(false);
    expect(handler.match('alert: fire')).toBe(false);
  });

  it('matches any channel when no filter set', () => {
    const cb = vi.fn();
    const handler = new MessageHandler('hello', undefined, cb);

    expect(handler.match('hello world', 'any-channel')).toBe(true);
    expect(handler.match('hello world')).toBe(true);
  });
});
