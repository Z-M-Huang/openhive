import { describe, it, expect, vi } from 'vitest';
import { RouterImpl } from './router.js';
import type { InboundMessage } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { ChannelType } from '../domain/enums.js';

function makeMessage(content: string, chatJid = 'chat-1'): InboundMessage {
  return {
    id: 'msg-1',
    chatJid,
    channelType: ChannelType.Discord,
    content,
    timestamp: Date.now(),
  };
}

describe('RouterImpl', () => {
  // -------------------------------------------------------------------------
  // Tier 1: Exact matching
  // -------------------------------------------------------------------------

  it('exact match on message content', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('hello', 'greeting-team', 'exact');

    const result = await router.route(makeMessage('hello'));
    expect(result).toBe('greeting-team');
  });

  it('exact match on chatJid', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('discord-channel-123', 'support-team', 'exact');

    const result = await router.route(makeMessage('anything', 'discord-channel-123'));
    expect(result).toBe('support-team');
  });

  it('exact match requires full equality', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('hello', 'greeting-team', 'exact');

    // 'hello world' should NOT match exact 'hello'
    await expect(router.route(makeMessage('hello world'))).rejects.toThrow(NotFoundError);
  });

  // -------------------------------------------------------------------------
  // Tier 1: Prefix matching
  // -------------------------------------------------------------------------

  it('prefix match on message content', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('/cmd', 'cmd-team', 'prefix');

    const result = await router.route(makeMessage('/cmd deploy'));
    expect(result).toBe('cmd-team');
  });

  it('prefix match on chatJid', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('discord-', 'discord-team', 'prefix');

    const result = await router.route(makeMessage('hi', 'discord-channel-42'));
    expect(result).toBe('discord-team');
  });

  // -------------------------------------------------------------------------
  // Tier 1: Regex matching
  // -------------------------------------------------------------------------

  it('regex match on message content', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('^bug\\s+\\d+$', 'bug-team', 'regex');

    const result = await router.route(makeMessage('bug 123'));
    expect(result).toBe('bug-team');
  });

  it('regex does not match non-matching content', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('^bug\\s+\\d+$', 'bug-team', 'regex');

    await expect(router.route(makeMessage('feature request'))).rejects.toThrow(NotFoundError);
  });

  // -------------------------------------------------------------------------
  // Priority ordering
  // -------------------------------------------------------------------------

  it('exact match wins over prefix', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('hel', 'prefix-team', 'prefix');
    router.addKnownRoute('hello', 'exact-team', 'exact');

    // 'hello' matches both exact 'hello' and prefix 'hel', exact wins
    const result = await router.route(makeMessage('hello'));
    expect(result).toBe('exact-team');
  });

  it('prefix match wins over regex', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('.*cmd.*', 'regex-team', 'regex');
    router.addKnownRoute('/cmd', 'prefix-team', 'prefix');

    const result = await router.route(makeMessage('/cmd test'));
    expect(result).toBe('prefix-team');
  });

  it('exact > prefix > regex priority holds regardless of insertion order', async () => {
    const router = new RouterImpl();
    // Insert in reverse priority order
    router.addKnownRoute('.*deploy.*', 'regex-team', 'regex');
    router.addKnownRoute('/deploy', 'prefix-team', 'prefix');
    router.addKnownRoute('/deploy', 'exact-team', 'exact');

    const result = await router.route(makeMessage('/deploy'));
    expect(result).toBe('exact-team');
  });

  // -------------------------------------------------------------------------
  // Conflict detection
  // -------------------------------------------------------------------------

  it('detects overlapping prefix routes to different teams', () => {
    const router = new RouterImpl();
    router.addKnownRoute('/cmd', 'team-a', 'prefix');

    expect(() => router.addKnownRoute('/cmd/', 'team-b', 'prefix')).toThrow(ConflictError);
  });

  it('allows overlapping prefixes to the same team', () => {
    const router = new RouterImpl();
    router.addKnownRoute('/cmd', 'team-a', 'prefix');

    // Same team — not a conflict
    expect(() => router.addKnownRoute('/cmd/', 'team-a', 'prefix')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Update existing route
  // -------------------------------------------------------------------------

  it('updating an existing route changes the target team', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('hello', 'old-team', 'exact');
    router.addKnownRoute('hello', 'new-team', 'exact');

    const result = await router.route(makeMessage('hello'));
    expect(result).toBe('new-team');
  });

  // -------------------------------------------------------------------------
  // Add / remove round-trip
  // -------------------------------------------------------------------------

  it('add then remove returns to no routes', async () => {
    const router = new RouterImpl();
    router.addKnownRoute('test', 'team-a', 'exact');
    expect(router.listKnownRoutes()).toHaveLength(1);

    router.removeKnownRoute('test');
    expect(router.listKnownRoutes()).toHaveLength(0);

    await expect(router.route(makeMessage('test'))).rejects.toThrow(NotFoundError);
  });

  it('remove non-existent route is a no-op', () => {
    const router = new RouterImpl();
    expect(() => router.removeKnownRoute('nonexistent')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // listKnownRoutes
  // -------------------------------------------------------------------------

  it('listKnownRoutes returns all registered routes', () => {
    const router = new RouterImpl();
    router.addKnownRoute('a', 'team-a', 'exact');
    router.addKnownRoute('b', 'team-b', 'prefix');
    router.addKnownRoute('^c$', 'team-c', 'regex');

    const routes = router.listKnownRoutes();
    expect(routes).toHaveLength(3);
    expect(routes.map((r) => r.pattern)).toEqual(expect.arrayContaining(['a', 'b', '^c$']));
  });

  // -------------------------------------------------------------------------
  // Tier 2: LLM fallback
  // -------------------------------------------------------------------------

  it('falls through to Tier 2 handler when no Tier 1 match', async () => {
    const tier2 = vi.fn().mockResolvedValue('llm-routed-team');
    const router = new RouterImpl(tier2);

    const msg = makeMessage('something novel');
    const result = await router.route(msg);

    expect(result).toBe('llm-routed-team');
    expect(tier2).toHaveBeenCalledWith(msg);
  });

  it('Tier 1 match bypasses Tier 2 handler', async () => {
    const tier2 = vi.fn().mockResolvedValue('llm-team');
    const router = new RouterImpl(tier2);
    router.addKnownRoute('direct', 'config-team', 'exact');

    const result = await router.route(makeMessage('direct'));
    expect(result).toBe('config-team');
    expect(tier2).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when no match and no Tier 2 handler', async () => {
    const router = new RouterImpl();

    await expect(router.route(makeMessage('no match'))).rejects.toThrow(NotFoundError);
  });

  // -------------------------------------------------------------------------
  // setTier2Handler
  // -------------------------------------------------------------------------

  it('setTier2Handler replaces the Tier 2 callback', async () => {
    const router = new RouterImpl();
    router.setTier2Handler(async () => 'new-handler-team');

    const result = await router.route(makeMessage('anything'));
    expect(result).toBe('new-handler-team');
  });
});
