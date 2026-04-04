import { describe, it, expect } from 'vitest';
import { TopicSessionManager } from './topic-session-manager.js';

describe('TopicSessionManager', () => {
  it('serializes work for the same topicId', async () => {
    const mgr = new TopicSessionManager();
    const order: string[] = [];

    const first = mgr.enqueue('a', async () => {
      order.push('first-start');
      await delay(50);
      order.push('first-end');
      return 1;
    });

    const second = mgr.enqueue('a', async () => {
      order.push('second-start');
      return 2;
    });

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('runs different topicIds in parallel', async () => {
    const mgr = new TopicSessionManager();
    const order: string[] = [];

    const a = mgr.enqueue('a', async () => {
      order.push('a-start');
      await delay(50);
      order.push('a-end');
    });

    const b = mgr.enqueue('b', async () => {
      order.push('b-start');
      await delay(50);
      order.push('b-end');
    });

    await Promise.all([a, b]);
    // Both should start before either ends
    expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'));
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('b-end'));
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('does not block next work when previous fails', async () => {
    const mgr = new TopicSessionManager();

    const first = mgr.enqueue('a', async () => { throw new Error('boom'); });
    await expect(first).rejects.toThrow('boom');

    const second = mgr.enqueue('a', async () => 'ok');
    expect(await second).toBe('ok');
  });

  it('cleans up queue after last promise resolves', async () => {
    const mgr = new TopicSessionManager();
    expect(mgr.activeCount()).toBe(0);

    const p = mgr.enqueue('a', async () => 'done');
    expect(mgr.activeCount()).toBe(1);

    await p;
    // Allow microtask for cleanup
    await delay(0);
    expect(mgr.activeCount()).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
