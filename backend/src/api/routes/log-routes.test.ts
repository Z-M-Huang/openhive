/**
 * Tests for GET /api/logs/stream (SSE) route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EventBus, BusEvent } from '../../domain/index.js';
import { registerRoutes, resetSseStateForTest, type RouteContext } from './index.js';
import { MockFastify, makeMockRequest, makeMockReply, createMockEventBus, type MockRequest, type MockReply } from './__test-helpers.js';

describe('GET /api/logs/stream', () => {
  let app: MockFastify;
  let eventBus: EventBus;
  let ctx: RouteContext;

  beforeEach(() => {
    resetSseStateForTest();
    app = new MockFastify();
    eventBus = createMockEventBus();
    ctx = { eventBus };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  afterEach(() => {
    resetSseStateForTest();
  });

  it('sets SSE headers and writes initial connected event', async () => {
    const req = makeMockRequest();
    const reply = makeMockReply();

    await (app as unknown as MockFastify & {
      call: (m: string, p: string, r?: Partial<MockRequest>) => Promise<MockReply>
    }).call('GET', '/api/logs/stream', req);

    expect(reply.raw.setHeader).not.toHaveBeenCalled(); // Validate via the route handler directly
    // Instead: invoke the captured handler
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    expect(handler).toBeDefined();
    const req2 = makeMockRequest();
    const reply2 = makeMockReply();
    await handler(req2, reply2);

    expect(reply2.raw.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply2.raw.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply2.raw.write).toHaveBeenCalledWith('data: {"type":"connected"}\n\n');
  });

  it('subscribes to EventBus when first client connects', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    await handler(makeMockRequest(), makeMockReply());

    expect(eventBus.filteredSubscribe).toHaveBeenCalledOnce();
  });

  it('does not create duplicate EventBus subscriptions for multiple clients', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    await handler(makeMockRequest(), makeMockReply());
    await handler(makeMockRequest(), makeMockReply());

    // Still only one subscription despite two clients
    expect(eventBus.filteredSubscribe).toHaveBeenCalledOnce();
  });

  it('fans out log events to all connected clients', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const reply1 = makeMockReply();
    const reply2 = makeMockReply();
    await handler(makeMockRequest(), reply1);
    await handler(makeMockRequest(), reply2);

    const logEvent: BusEvent = { type: 'log_event', data: { msg: 'hello' }, timestamp: 1 };
    (eventBus.publish as ReturnType<typeof vi.fn>)(logEvent);

    const frame = `data: ${JSON.stringify(logEvent)}\n\n`;
    expect(reply1.raw.write).toHaveBeenCalledWith(frame);
    expect(reply2.raw.write).toHaveBeenCalledWith(frame);
  });

  it('does not fan out non-log events to SSE clients', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const reply1 = makeMockReply();
    await handler(makeMockRequest(), reply1);

    const taskEvent: BusEvent = { type: 'task.dispatched', data: {}, timestamp: 1 };
    (eventBus.publish as ReturnType<typeof vi.fn>)(taskEvent);

    // Only the initial connected frame should have been written, not the task event
    expect(reply1.raw.write).toHaveBeenCalledTimes(1);
    expect(reply1.raw.write).toHaveBeenCalledWith('data: {"type":"connected"}\n\n');
  });

  it('skips clients whose raw stream is not writable (backpressure)', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const writableReply = makeMockReply(true);
    const nonWritableReply = makeMockReply(false);
    // Manually set writable=false after initial connected write
    await handler(makeMockRequest(), writableReply);
    await handler(makeMockRequest(), nonWritableReply);
    // Override writable to false after connection
    nonWritableReply.raw.writable = false;

    const logEvent: BusEvent = { type: 'log_event', data: {}, timestamp: 1 };
    (eventBus.publish as ReturnType<typeof vi.fn>)(logEvent);

    const frame = `data: ${JSON.stringify(logEvent)}\n\n`;
    expect(writableReply.raw.write).toHaveBeenCalledWith(frame);
    // non-writable client should NOT receive the event frame
    expect(nonWritableReply.raw.write).not.toHaveBeenCalledWith(frame);
  });

  it('removes client and unsubscribes EventBus on close when last client disconnects', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const req = makeMockRequest();
    await handler(req, makeMockReply());

    // Simulate client disconnect
    const closeHandler = (req.raw.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'close',
    )?.[1] as (() => void) | undefined;
    expect(closeHandler).toBeDefined();
    closeHandler!();

    // EventBus should be unsubscribed when all clients disconnect
    expect(eventBus.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not unsubscribe EventBus when some clients remain after one disconnects', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const req1 = makeMockRequest();
    const req2 = makeMockRequest();
    await handler(req1, makeMockReply());
    await handler(req2, makeMockReply());

    // Disconnect only the first client
    const closeHandler1 = (req1.raw.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'close',
    )?.[1] as (() => void) | undefined;
    closeHandler1!();

    // EventBus should NOT be unsubscribed because req2 is still connected
    expect(eventBus.unsubscribe).not.toHaveBeenCalled();
  });

  it('returns 503 when SSE client limit (50) is reached', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;

    // Fill up to the limit (50 clients)
    for (let i = 0; i < 50; i++) {
      await handler(makeMockRequest(), makeMockReply());
    }

    // The 51st connection should be rejected
    const reply = makeMockReply();
    await handler(makeMockRequest(), reply);
    expect(reply._status).toBe(503);
  });

  it('does not subscribe to EventBus when eventBus is not in context', async () => {
    resetSseStateForTest();
    const app2 = new MockFastify();
    const noEventBusCtx: RouteContext = {};
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], noEventBusCtx);

    const routes = (app2 as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const reply = makeMockReply();
    await handler(makeMockRequest(), reply);

    // Should still write the initial connected frame (connection succeeds)
    expect(reply.raw.write).toHaveBeenCalledWith('data: {"type":"connected"}\n\n');
    // But no subscription was created (eventBus.filteredSubscribe not called)
    expect(eventBus.filteredSubscribe).not.toHaveBeenCalled();
  });
});
