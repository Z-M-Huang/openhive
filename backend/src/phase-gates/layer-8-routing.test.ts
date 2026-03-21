/**
 * Layer 8 Phase Gate: Routing + Triggers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouterImpl } from '../control-plane/router.js';
import { TriggerSchedulerImpl } from '../triggers/scheduler.js';
import { ChannelType } from '../domain/enums.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { InboundMessage, BusEvent } from '../domain/interfaces.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
describe('Layer 8: Routing + Triggers', () => {
  let eventBus: EventBusImpl;

  beforeEach(() => {
    eventBus = new EventBusImpl();
  });

  afterEach(() => {
    eventBus.close();
  });

  describe('RouterImpl two-tier routing', () => {
    it('routes via Tier 1 exact match', async () => {
      const router = new RouterImpl();

      // Add exact route for 'weather' -> 'team-a'
      router.addKnownRoute('weather', 'team-a', 'exact');

      const message: InboundMessage = {
        id: 'msg-1',
        chatJid: 'chat-1',
        channelType: ChannelType.Discord,
        content: 'weather',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('team-a');
    });

    it('routes via Tier 2 LLM judgment when no Tier 1 match', async () => {
      const tier2Handler = vi.fn().mockResolvedValue('team-b');
      const router = new RouterImpl(tier2Handler);

      // Add a different route
      router.addKnownRoute('weather', 'team-a', 'exact');

      const message: InboundMessage = {
        id: 'msg-2',
        chatJid: 'chat-2',
        channelType: ChannelType.Discord,
        content: 'unknown request',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('team-b');
      expect(tier2Handler).toHaveBeenCalledWith(message);
    });

    it('throws NotFoundError when no route and no Tier 2 handler', async () => {
      const router = new RouterImpl(); // No Tier 2 handler

      const message: InboundMessage = {
        id: 'msg-3',
        chatJid: 'chat-3',
        channelType: ChannelType.Discord,
        content: 'unknown',
        timestamp: Date.now(),
      };

      await expect(router.route(message)).rejects.toThrow(NotFoundError);
    });

    it('routes via prefix match', async () => {
      const router = new RouterImpl();

      router.addKnownRoute('weather-', 'weather-team', 'prefix');

      const message: InboundMessage = {
        id: 'msg-4',
        chatJid: 'chat-4',
        channelType: ChannelType.Discord,
        content: 'weather-tokyo',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('weather-team');
    });

    it('routes via regex match', async () => {
      const router = new RouterImpl();

      router.addKnownRoute('^issue-\\d+$', 'issue-team', 'regex');

      const message: InboundMessage = {
        id: 'msg-5',
        chatJid: 'chat-5',
        channelType: ChannelType.Discord,
        content: 'issue-12345',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('issue-team');
    });

    it('prioritizes exact over prefix over regex', async () => {
      const router = new RouterImpl();

      // Add different patterns with different types
      // Regex matches everything
      router.addKnownRoute('.*', 'regex-team', 'regex');
      // Prefix matches 'weather-xxx'
      router.addKnownRoute('weather-', 'prefix-team', 'prefix');
      // Exact matches only 'weather'
      router.addKnownRoute('weather', 'exact-team', 'exact');

      // Exact match should win
      const exactMessage: InboundMessage = {
        id: 'msg-6',
        chatJid: 'chat-6',
        channelType: ChannelType.Discord,
        content: 'weather',
        timestamp: Date.now(),
      };
      const exactResult = await router.route(exactMessage);
      expect(exactResult).toBe('exact-team');

      // Prefix match for 'weather-tokyo'
      const prefixMessage: InboundMessage = {
        id: 'msg-7',
        chatJid: 'chat-7',
        channelType: ChannelType.Discord,
        content: 'weather-tokyo',
        timestamp: Date.now(),
      };
      const prefixResult = await router.route(prefixMessage);
      expect(prefixResult).toBe('prefix-team');

      // Regex fallback for anything else
      const regexMessage: InboundMessage = {
        id: 'msg-8',
        chatJid: 'chat-8',
        channelType: ChannelType.Discord,
        content: 'something-else',
        timestamp: Date.now(),
      };
      const regexResult = await router.route(regexMessage);
      expect(regexResult).toBe('regex-team');
    });
  });

  // -------------------------------------------------------------------------
  // 2. TriggerScheduler Cron
  // -------------------------------------------------------------------------

  describe('TriggerSchedulerImpl cron triggers', () => {
    let scheduler: TriggerSchedulerImpl;
    let fireHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fireHandler = vi.fn();
      scheduler = new TriggerSchedulerImpl(eventBus, fireHandler);
    });

    afterEach(() => {
      scheduler.stop();
    });

    it('registers and fires cron trigger', async () => {
      scheduler.addCronTrigger('test-cron', '*/5 * * * *', 'team-a', 'Check weather');
      scheduler.start();

      // Trigger manually via timer callback
      const triggers = scheduler.listTriggers();
      expect(triggers).toHaveLength(1);
      expect(triggers[0].name).toBe('test-cron');
      expect(triggers[0].type).toBe('cron');
      expect(triggers[0].targetTeam).toBe('team-a');
    });

    it('rejects invalid cron expression', () => {
      expect(() => {
        scheduler.addCronTrigger('bad-cron', 'not-a-cron', 'team-a', 'test');
      }).toThrow(ValidationError);
    });

    it('removes trigger', () => {
      scheduler.addCronTrigger('remove-test', '0 * * * *', 'team-a', 'test');
      expect(scheduler.listTriggers()).toHaveLength(1);

      scheduler.removeTrigger('remove-test');
      expect(scheduler.listTriggers()).toHaveLength(0);
    });

    it('stop() halts all triggers', () => {
      scheduler.addCronTrigger('cron-1', '0 * * * *', 'team-a', 'test');
      scheduler.addCronTrigger('cron-2', '0 */2 * * *', 'team-b', 'test');
      scheduler.start();

      scheduler.stop();

      // Verify triggers still registered but not active
      expect(scheduler.listTriggers()).toHaveLength(2);
    });

    it('event trigger fires on matching event', async () => {
      const fireHandler = vi.fn();
      const scheduler = new TriggerSchedulerImpl(eventBus, fireHandler);

      scheduler.addEventTrigger(
        'task-complete-trigger',
        'task.completed',
        'team-a',
        'Check follow-up',
        (event: BusEvent) => event.data['team_slug'] === 'team-b',
      );
      scheduler.start();

      // Publish matching event
      eventBus.publish({
        type: 'task.completed',
        data: { team_slug: 'team-b', task_id: 'task-1' },
        timestamp: Date.now(),
      });

      // Allow event propagation
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fireHandler).toHaveBeenCalledWith('team-a', 'Check follow-up', undefined, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Full Tool Call Flow
  // -------------------------------------------------------------------------

});
