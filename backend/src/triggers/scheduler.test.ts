import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriggerSchedulerImpl } from './scheduler.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
import type { BusEvent } from '../domain/index.js';
import { ValidationError } from '../domain/errors.js';

/** Flush pending microtasks so queueMicrotask callbacks execute. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TriggerSchedulerImpl', () => {
  let eventBus: EventBusImpl;
  let fireSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBusImpl();
    fireSpy = vi.fn();
  });

  afterEach(() => {
    eventBus.close();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Cron triggers
  // -------------------------------------------------------------------------

  it('cron trigger fires and dispatches task', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    // Every second
    scheduler.addCronTrigger('test-cron', '* * * * * *', 'weather-team', 'check weather');
    scheduler.start();

    // Advance time by 1 second to trigger cron
    vi.advanceTimersByTime(1100);

    expect(fireSpy).toHaveBeenCalledWith('weather-team', 'check weather');
  });

  it('rejects invalid cron expression', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    expect(() =>
      scheduler.addCronTrigger('bad', 'not a cron', 'team', 'prompt')
    ).toThrow(ValidationError);
  });

  it('cron trigger does not fire before start()', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addCronTrigger('test', '* * * * * *', 'team', 'prompt');

    vi.advanceTimersByTime(2000);
    expect(fireSpy).not.toHaveBeenCalled();

    // Now start
    scheduler.start();
    vi.advanceTimersByTime(1100);
    expect(fireSpy).toHaveBeenCalled();

    scheduler.stop();
  });

  it('replacing an existing cron trigger by name', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addCronTrigger('dup', '* * * * * *', 'old-team', 'old prompt');
    scheduler.addCronTrigger('dup', '* * * * * *', 'new-team', 'new prompt');
    scheduler.start();

    vi.advanceTimersByTime(1100);

    expect(fireSpy).toHaveBeenCalledWith('new-team', 'new prompt');
    // Should NOT have been called with old values
    expect(fireSpy).not.toHaveBeenCalledWith('old-team', 'old prompt');

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Webhook triggers
  // -------------------------------------------------------------------------

  it('accepts valid webhook path', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    expect(() =>
      scheduler.addWebhookTrigger('wh', 'my-webhook', 'team-a')
    ).not.toThrow();

    const triggers = scheduler.listTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.type).toBe('webhook');
  });

  it('rejects webhook path shadowing /api/*', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    expect(() =>
      scheduler.addWebhookTrigger('bad', '/api/health', 'team-a')
    ).toThrow(ValidationError);
  });

  it('rejects webhook path with invalid characters', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    expect(() =>
      scheduler.addWebhookTrigger('bad', 'my_webhook', 'team-a')
    ).toThrow(ValidationError);
  });

  // -------------------------------------------------------------------------
  // Event triggers (channel_event)
  // -------------------------------------------------------------------------

  it('event trigger fires on matching EventBus event', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addEventTrigger('evt', 'channel.message', 'chat-team', 'process message');
    scheduler.start();

    const event: BusEvent = {
      type: 'channel.message',
      data: { content: 'hi' },
      timestamp: Date.now(),
    };
    eventBus.publish(event);
    await flushMicrotasks();

    expect(fireSpy).toHaveBeenCalledWith('chat-team', 'process message');
  });

  it('event trigger ignores non-matching event type', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addEventTrigger('evt', 'channel.message', 'chat-team', 'process');
    scheduler.start();

    eventBus.publish({ type: 'task.completed', data: {}, timestamp: Date.now() });
    await flushMicrotasks();

    expect(fireSpy).not.toHaveBeenCalled();
  });

  it('event trigger with custom filter', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addEventTrigger(
      'filtered',
      'channel.message',
      'vip-team',
      'handle vip',
      (event) => event.data['priority'] === 'high',
    );
    scheduler.start();

    // Low priority — should not fire
    eventBus.publish({
      type: 'channel.message',
      data: { priority: 'low' },
      timestamp: Date.now(),
    });
    await flushMicrotasks();
    expect(fireSpy).not.toHaveBeenCalled();

    // High priority — should fire
    eventBus.publish({
      type: 'channel.message',
      data: { priority: 'high' },
      timestamp: Date.now(),
    });
    await flushMicrotasks();
    expect(fireSpy).toHaveBeenCalledWith('vip-team', 'handle vip');
  });

  // -------------------------------------------------------------------------
  // Task completion triggers
  // -------------------------------------------------------------------------

  it('task completion trigger fires on task.completed event', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addTaskCompletionTrigger('tc', 'followup-team', 'run followup');
    scheduler.start();

    eventBus.publish({
      type: 'task.completed',
      data: { task_id: 'task-1', team_slug: 'any', status: 'completed' },
      timestamp: Date.now(),
    });
    await flushMicrotasks();

    expect(fireSpy).toHaveBeenCalledWith('followup-team', 'run followup');
  });

  it('task completion trigger filters by source team', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addTaskCompletionTrigger('tc', 'followup-team', 'run followup', 'data-team');
    scheduler.start();

    // Wrong source team
    eventBus.publish({
      type: 'task.completed',
      data: { team_slug: 'other-team', status: 'completed' },
      timestamp: Date.now(),
    });
    await flushMicrotasks();
    expect(fireSpy).not.toHaveBeenCalled();

    // Correct source team
    eventBus.publish({
      type: 'task.completed',
      data: { team_slug: 'data-team', status: 'completed' },
      timestamp: Date.now(),
    });
    await flushMicrotasks();
    expect(fireSpy).toHaveBeenCalledWith('followup-team', 'run followup');
  });

  // -------------------------------------------------------------------------
  // Remove trigger
  // -------------------------------------------------------------------------

  it('removing a cron trigger stops it from firing', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addCronTrigger('rm-cron', '* * * * * *', 'team', 'prompt');
    scheduler.start();

    vi.advanceTimersByTime(1100);
    expect(fireSpy).toHaveBeenCalledTimes(1);

    scheduler.removeTrigger('rm-cron');
    vi.advanceTimersByTime(2000);
    // Should still be exactly 1 call
    expect(fireSpy).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('removing an event trigger unsubscribes from EventBus', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addEventTrigger('rm-evt', 'test.event', 'team', 'prompt');
    scheduler.start();

    scheduler.removeTrigger('rm-evt');

    eventBus.publish({ type: 'test.event', data: {}, timestamp: Date.now() });
    await flushMicrotasks();

    expect(fireSpy).not.toHaveBeenCalled();
  });

  it('removing non-existent trigger is a no-op', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    expect(() => scheduler.removeTrigger('ghost')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  it('stop() deactivates all triggers', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addCronTrigger('c1', '* * * * * *', 'team', 'prompt');
    scheduler.addEventTrigger('e1', 'test.event', 'team', 'prompt');
    scheduler.start();

    scheduler.stop();

    vi.advanceTimersByTime(2000);
    eventBus.publish({ type: 'test.event', data: {}, timestamp: Date.now() });
    await flushMicrotasks();

    expect(fireSpy).not.toHaveBeenCalled();
  });

  it('start() is idempotent', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.start();
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // listTriggers
  // -------------------------------------------------------------------------

  it('listTriggers returns all registered triggers', () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addCronTrigger('cron-1', '0 9 * * *', 'team-a', 'morning check');
    scheduler.addWebhookTrigger('wh-1', 'deploy-hook', 'team-b');
    scheduler.addEventTrigger('evt-1', 'channel.message', 'team-c', 'handle');

    const list = scheduler.listTriggers();
    expect(list).toHaveLength(3);
    expect(list.map((t) => t.name).sort()).toEqual(['cron-1', 'evt-1', 'wh-1']);

    const cronEntry = list.find((t) => t.name === 'cron-1');
    expect(cronEntry?.type).toBe('cron');
    expect(cronEntry?.schedule).toBe('0 9 * * *');
    expect(cronEntry?.teamSlug).toBe('team-a');
  });

  // -------------------------------------------------------------------------
  // loadTriggers
  // -------------------------------------------------------------------------

  it('loadTriggers clears existing triggers', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.addCronTrigger('c1', '* * * * *', 'team', 'prompt');
    expect(scheduler.listTriggers()).toHaveLength(1);

    await scheduler.loadTriggers();
    expect(scheduler.listTriggers()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Adding trigger while scheduler is already running
  // -------------------------------------------------------------------------

  it('cron trigger added after start() is immediately active', async () => {
    const scheduler = new TriggerSchedulerImpl(eventBus, fireSpy);
    scheduler.start();

    scheduler.addCronTrigger('late', '* * * * * *', 'team', 'late prompt');
    vi.advanceTimersByTime(1100);

    expect(fireSpy).toHaveBeenCalledWith('team', 'late prompt');
    scheduler.stop();
  });
});
