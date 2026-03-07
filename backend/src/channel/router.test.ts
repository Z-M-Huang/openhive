/**
 * Tests for Router (backend/src/channel/router.ts)
 *
 * Uses vi.fn() mocks for all dependencies (WSHub, TaskStore, SessionStore,
 * MessageStore, ChannelAdapter). No real DB or network I/O.
 *
 * Covers:
 *   1.  RouteInbound creates task and dispatches via WS
 *   2.  RouteInbound enforces max message length
 *   3.  RouteInbound HTML-escapes content
 *   4.  RouteInbound persists inbound message
 *   5.  RouteOutbound routes to correct channel by prefix
 *   6.  RouteOutbound strips agent_response tags
 *   7.  HandleTaskResult updates task and routes response
 *   8.  HandleTaskResult sends generic message on failure
 *   9.  RecoverInFlight re-dispatches in-flight tasks
 *  10.  RegisterChannel rejects duplicate prefix
 *  11.  FormatUserMessage wraps content correctly
 *  12.  StripResponseTags removes XML wrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Router, formatUserMessage, stripResponseTags, extractPrefix } from './router.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { RouterConfig, RouterLogger } from './router.js';
import type { ChannelAdapter, WSHub, TaskStore, SessionStore, MessageStore } from '../domain/interfaces.js';
import type { Task, ChatSession, Message } from '../domain/types.js';
import type { TaskResultMsg } from '../ws/messages.js';

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/** Creates a no-op logger that can be spied on. */
function makeLogger(): RouterLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Creates a minimal ChatSession. */
function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    chat_jid: overrides.chat_jid ?? 'discord:user-1',
    channel_type: overrides.channel_type ?? 'discord',
    last_timestamp: overrides.last_timestamp ?? new Date(0),
    last_agent_timestamp: overrides.last_agent_timestamp ?? new Date(0),
    agent_aid: overrides.agent_aid ?? 'aid-main-001',
    session_id: overrides.session_id ?? 'sess-1',
  };
}

/** Creates a minimal Task. */
function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    team_slug: overrides.team_slug ?? 'main',
    agent_aid: overrides.agent_aid ?? 'aid-main-001',
    jid: overrides.jid ?? 'discord:user-1',
    status: overrides.status ?? 'pending',
    prompt: overrides.prompt ?? '<user_message channel="discord">hello</user_message>',
    created_at: overrides.created_at ?? new Date(1_000_000),
    updated_at: overrides.updated_at ?? new Date(1_000_000),
    completed_at: overrides.completed_at ?? null,
    result: overrides.result,
    error: overrides.error,
    parent_id: overrides.parent_id,
  };
}

/** Creates a mock WSHub. */
function makeWSHub(): WSHub {
  return {
    registerConnection: vi.fn(),
    unregisterConnection: vi.fn(),
    sendToTeam: vi.fn().mockResolvedValue(undefined),
    broadcastAll: vi.fn().mockResolvedValue(undefined),
    generateToken: vi.fn().mockReturnValue('token-abc'),
    getUpgradeHandler: vi.fn(),
    getConnectedTeams: vi.fn().mockReturnValue([]),
    setOnMessage: vi.fn(),
    setOnConnect: vi.fn(),
  };
}

/** Creates a mock TaskStore. */
function makeTaskStore(session?: ChatSession): TaskStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(makeTask({ id: 'task-1', jid: session?.chat_jid ?? 'discord:user-1' })),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTeam: vi.fn().mockResolvedValue([]),
    listByStatus: vi.fn().mockResolvedValue([]),
    getSubtree: vi.fn().mockResolvedValue([]),
  };
}

/** Creates a mock SessionStore with a pre-existing session. */
function makeSessionStore(session: ChatSession): SessionStore {
  return {
    get: vi.fn().mockResolvedValue(session),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([session]),
  };
}

/** Creates a mock SessionStore that throws NotFoundError on get (new session). */
function makeEmptySessionStore(): SessionStore {
  return {
    get: vi.fn().mockRejectedValue(new NotFoundError('session', 'discord:user-1')),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
  };
}

/** Creates a mock MessageStore. */
function makeMessageStore(): MessageStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    getByChat: vi.fn().mockResolvedValue([]),
    getLatest: vi.fn().mockResolvedValue([]),
    deleteByChat: vi.fn().mockResolvedValue(undefined),
    deleteBefore: vi.fn().mockResolvedValue(0),
  };
}

/** Creates a mock ChannelAdapter. */
function makeAdapter(prefix: string, connected = true): ChannelAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getJIDPrefix: vi.fn().mockReturnValue(prefix),
    isConnected: vi.fn().mockReturnValue(connected),
    onMessage: vi.fn(),
    onMetadata: vi.fn(),
  };
}

/** Builds a RouterConfig with all mocks. */
function makeConfig(
  overrides: Partial<RouterConfig> = {},
): RouterConfig & {
  wsHub: WSHub;
  taskStore: TaskStore;
  sessionStore: SessionStore;
  messageStore: MessageStore;
  logger: RouterLogger;
} {
  const session = makeSession();
  const wsHub = overrides.wsHub ?? makeWSHub();
  const taskStore = overrides.taskStore ?? makeTaskStore(session);
  const sessionStore = overrides.sessionStore ?? makeSessionStore(session);
  const messageStore = overrides.messageStore ?? makeMessageStore();
  const logger = overrides.logger ?? makeLogger();

  return {
    wsHub,
    taskStore,
    sessionStore,
    messageStore,
    logger,
    mainTeamID: overrides.mainTeamID ?? 'tid-main-001',
    mainAssistantAID: overrides.mainAssistantAID ?? 'aid-main-001',
    maxMessageLength: overrides.maxMessageLength,
  };
}

// ---------------------------------------------------------------------------
// Test 1: RouteInbound creates task and dispatches via WS
// ---------------------------------------------------------------------------

describe('RouteInbound creates task and dispatches via WS', () => {
  it('creates a task record and sends task_dispatch to the hub', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    await router.routeInbound('discord:user-1', 'hello world');

    // Task was created
    expect(cfg.taskStore.create).toHaveBeenCalledOnce();
    const createdTask = (cfg.taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Task;
    expect(createdTask.team_slug).toBe('main');
    expect(createdTask.jid).toBe('discord:user-1');
    expect(createdTask.status).toBe('pending');
    expect(createdTask.prompt).toContain('<user_message channel="discord">');

    // WebSocket dispatch was sent
    expect(cfg.wsHub.sendToTeam).toHaveBeenCalledOnce();
    const [teamID, encoded] = (cfg.wsHub.sendToTeam as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(teamID).toBe('tid-main-001');
    const envelope = JSON.parse(encoded) as { type: string; data: Record<string, unknown> };
    expect(envelope.type).toBe('task_dispatch');
    expect(envelope.data['task_id']).toBe(createdTask.id);
  });
});

// ---------------------------------------------------------------------------
// Test 2: RouteInbound enforces max message length
// ---------------------------------------------------------------------------

describe('RouteInbound enforces max message length', () => {
  it('throws ValidationError when content exceeds maxMessageLength', async () => {
    const cfg = makeConfig({ maxMessageLength: 10 });
    const router = new Router(cfg);

    await expect(router.routeInbound('discord:user-1', 'x'.repeat(11))).rejects.toThrow(
      ValidationError,
    );

    // No task was created
    expect(cfg.taskStore.create).not.toHaveBeenCalled();
    // No WS dispatch
    expect(cfg.wsHub.sendToTeam).not.toHaveBeenCalled();
  });

  it('accepts content exactly at the limit', async () => {
    const cfg = makeConfig({ maxMessageLength: 10 });
    const router = new Router(cfg);

    await expect(router.routeInbound('discord:user-1', 'x'.repeat(10))).resolves.toBeUndefined();
    expect(cfg.taskStore.create).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Test 3: RouteInbound HTML-escapes content
// ---------------------------------------------------------------------------

describe('RouteInbound HTML-escapes content', () => {
  it('escapes & < > " and stores them as entities in the prompt', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    await router.routeInbound('discord:user-1', '<script>alert("xss")</script>');

    const createdTask = (cfg.taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Task;
    // The prompt should contain HTML entities, not the raw characters
    expect(createdTask.prompt).toContain('&lt;script&gt;');
    // htmlEscape uses &#34; for double-quotes (not &quot;)
    expect(createdTask.prompt).toContain('&#34;xss&#34;');
    // The raw characters should NOT appear in the prompt
    expect(createdTask.prompt).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// Test 4: RouteInbound persists inbound message
// ---------------------------------------------------------------------------

describe('RouteInbound persists inbound message', () => {
  it('calls messageStore.create with the original (unescaped) content', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    await router.routeInbound('discord:user-1', 'hello from discord');

    expect(cfg.messageStore!.create).toHaveBeenCalledOnce();
    const createdMsg = (cfg.messageStore!.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Message;
    expect(createdMsg.chat_jid).toBe('discord:user-1');
    expect(createdMsg.role).toBe('user');
    expect(createdMsg.content).toBe('hello from discord');
  });

  it('skips message persistence when messageStore is null', async () => {
    const cfg = makeConfig({ messageStore: null });
    const router = new Router(cfg);
    // Should not throw
    await expect(router.routeInbound('discord:user-1', 'hello')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 5: RouteOutbound routes to correct channel by prefix
// ---------------------------------------------------------------------------

describe('RouteOutbound routes to correct channel by prefix', () => {
  it('calls sendMessage on the adapter matching the JID prefix', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    const discordAdapter = makeAdapter('discord');
    await router.registerChannel(discordAdapter);

    await router.routeOutbound('discord:user-1', 'hello back');

    expect(discordAdapter.sendMessage).toHaveBeenCalledOnce();
    const [jid, content] = (discordAdapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(jid).toBe('discord:user-1');
    expect(content).toBe('hello back');
  });

  it('throws NotFoundError when no adapter is registered for the prefix', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    await expect(router.routeOutbound('discord:user-1', 'hello')).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Test 6: RouteOutbound strips agent_response tags
// ---------------------------------------------------------------------------

describe('RouteOutbound strips agent_response tags', () => {
  it('strips <agent_response> wrapper before sending to channel', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    const adapter = makeAdapter('discord');
    await router.registerChannel(adapter);

    const raw = '<agent_response>Hello, I am your assistant.</agent_response>';
    await router.routeOutbound('discord:user-1', raw);

    const [, sentContent] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(sentContent).toBe('Hello, I am your assistant.');
    expect(sentContent).not.toContain('<agent_response>');
  });

  it('strips <agent_response> tags with attributes', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    const adapter = makeAdapter('whatsapp');
    await router.registerChannel(adapter);

    const raw = '<agent_response version="1">Clean content.</agent_response>';
    await router.routeOutbound('whatsapp:+123', raw);

    const [, sentContent] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(sentContent).toBe('Clean content.');
  });
});

// ---------------------------------------------------------------------------
// Test 7: HandleTaskResult updates task and routes response
// ---------------------------------------------------------------------------

describe('HandleTaskResult updates task and routes response', () => {
  it('updates the task status to completed and routes the result to the channel', async () => {
    const session = makeSession({ chat_jid: 'discord:user-1' });
    const existingTask = makeTask({ id: 'task-1', jid: 'discord:user-1', status: 'running' });

    const taskStore = makeTaskStore(session);
    (taskStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(existingTask);

    const sessionStore = makeSessionStore(session);
    const messageStore = makeMessageStore();
    const cfg = makeConfig({ taskStore, sessionStore, messageStore });
    const router = new Router(cfg);

    const discordAdapter = makeAdapter('discord');
    await router.registerChannel(discordAdapter);

    const result: TaskResultMsg = {
      task_id: 'task-1',
      agent_aid: 'aid-main-001',
      status: 'completed',
      result: 'Here is your answer!',
      duration: 1000,
    };

    await router.handleTaskResult(result);

    // Task was updated
    expect(taskStore.update).toHaveBeenCalledOnce();
    const updatedTask = (taskStore.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Task;
    expect(updatedTask.status).toBe('completed');
    expect(updatedTask.result).toBe('Here is your answer!');
    expect(updatedTask.completed_at).not.toBeNull();

    // Response was sent to channel
    expect(discordAdapter.sendMessage).toHaveBeenCalledOnce();
    const [, sentContent] = (discordAdapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(sentContent).toBe('Here is your answer!');

    // Outbound message persisted
    expect(messageStore.create).toHaveBeenCalledOnce();
    const outboundMsg = (messageStore.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Message;
    expect(outboundMsg.role).toBe('assistant');
    expect(outboundMsg.content).toBe('Here is your answer!');
  });
});

// ---------------------------------------------------------------------------
// Test 8: HandleTaskResult sends generic message on failure
// ---------------------------------------------------------------------------

describe('HandleTaskResult sends generic message on failure', () => {
  it('sends a generic error message and NEVER exposes internal error details', async () => {
    const session = makeSession({ chat_jid: 'discord:user-1' });
    const existingTask = makeTask({ id: 'task-1', jid: 'discord:user-1', status: 'running' });

    const taskStore = makeTaskStore(session);
    (taskStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(existingTask);

    const sessionStore = makeSessionStore(session);
    const logger = makeLogger();
    const cfg = makeConfig({ taskStore, sessionStore, logger });
    const router = new Router(cfg);

    const discordAdapter = makeAdapter('discord');
    await router.registerChannel(discordAdapter);

    const internalError = 'connection refused at 127.0.0.1:5432';
    const result: TaskResultMsg = {
      task_id: 'task-1',
      agent_aid: 'aid-main-001',
      status: 'failed',
      error: internalError,
      duration: 500,
    };

    await router.handleTaskResult(result);

    // Task marked failed
    const updatedTask = (taskStore.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Task;
    expect(updatedTask.status).toBe('failed');
    expect(updatedTask.error).toBe(internalError);

    // Generic message sent to user, NOT the internal error
    expect(discordAdapter.sendMessage).toHaveBeenCalledOnce();
    const [, sentContent] = (discordAdapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(sentContent).not.toContain(internalError);
    expect(sentContent).toContain('Sorry');

    // Internal error was logged (not exposed to user)
    expect(logger.error).toHaveBeenCalled();
    const errorLogCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.['internal_error'] === internalError
    );
    expect(errorLogCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 9: RecoverInFlight re-dispatches in-flight tasks
// ---------------------------------------------------------------------------

describe('RecoverInFlight re-dispatches in-flight tasks', () => {
  it('re-dispatches a pending task when last_timestamp > last_agent_timestamp', async () => {
    const jid = 'discord:user-1';
    const pendingTask = makeTask({ id: 'task-pending', jid, status: 'pending' });

    // Session where last_timestamp is after last_agent_timestamp (in-flight)
    const inFlightSession: ChatSession = {
      chat_jid: jid,
      channel_type: 'discord',
      last_timestamp: new Date(2_000_000),
      last_agent_timestamp: new Date(1_000_000),
      agent_aid: 'aid-main-001',
      session_id: 'sess-1',
    };

    const taskStore = makeTaskStore(inFlightSession);
    (taskStore.listByTeam as ReturnType<typeof vi.fn>).mockResolvedValue([pendingTask]);

    const sessionStore = makeSessionStore(inFlightSession);
    (sessionStore.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([inFlightSession]);

    const wsHub = makeWSHub();
    const cfg = makeConfig({ taskStore, sessionStore, wsHub });
    const router = new Router(cfg);

    await router.recoverInFlight();

    // SendToTeam was called for the in-flight task
    expect(wsHub.sendToTeam).toHaveBeenCalledOnce();
    const [teamID, encoded] = (wsHub.sendToTeam as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(teamID).toBe('tid-main-001');
    const envelope = JSON.parse(encoded) as { type: string; data: Record<string, unknown> };
    expect(envelope.type).toBe('task_dispatch');
    expect(envelope.data['task_id']).toBe('task-pending');
  });

  it('skips sessions where last_timestamp <= last_agent_timestamp', async () => {
    const upToDateSession: ChatSession = {
      chat_jid: 'discord:user-2',
      channel_type: 'discord',
      last_timestamp: new Date(1_000_000),
      last_agent_timestamp: new Date(2_000_000), // agent responded more recently
      agent_aid: 'aid-main-001',
    };

    const sessionStore = makeSessionStore(upToDateSession);
    (sessionStore.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([upToDateSession]);

    const wsHub = makeWSHub();
    const cfg = makeConfig({ sessionStore, wsHub });
    const router = new Router(cfg);

    await router.recoverInFlight();
    expect(wsHub.sendToTeam).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 10: RegisterChannel rejects duplicate prefix
// ---------------------------------------------------------------------------

describe('RegisterChannel rejects duplicate prefix', () => {
  it('throws ConflictError when the same prefix is registered twice', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    const adapter1 = makeAdapter('discord');
    const adapter2 = makeAdapter('discord');

    await router.registerChannel(adapter1);

    await expect(router.registerChannel(adapter2)).rejects.toThrow(ConflictError);

    // Only the first adapter's onMessage was wired
    expect(adapter1.onMessage).toHaveBeenCalledOnce();
    expect(adapter2.onMessage).not.toHaveBeenCalled();
  });

  it('throws ValidationError when prefix is empty', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    const adapter = makeAdapter('');

    await expect(router.registerChannel(adapter)).rejects.toThrow(ValidationError);
  });

  it('getChannels includes registered channels', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    expect(router.getChannels()).toEqual({});

    const adapter = makeAdapter('discord', true);
    await router.registerChannel(adapter);

    const channels = router.getChannels();
    expect(channels['discord']).toBe(true);
  });

  it('unregisterChannel removes the channel', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    const adapter = makeAdapter('discord');
    await router.registerChannel(adapter);

    await router.unregisterChannel('discord');
    expect(router.getChannels()).toEqual({});
  });

  it('unregisterChannel throws NotFoundError for unknown prefix', async () => {
    const cfg = makeConfig();
    const router = new Router(cfg);

    await expect(router.unregisterChannel('discord')).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Test 11: FormatUserMessage wraps content correctly
// ---------------------------------------------------------------------------

describe('FormatUserMessage wraps content correctly', () => {
  it('wraps content in <user_message channel="..."> tags', () => {
    const result = formatUserMessage('discord', 'hello world');
    expect(result).toBe('<user_message channel="discord">hello world</user_message>');
  });

  it('uses the channelType as the channel attribute value', () => {
    const result = formatUserMessage('whatsapp', 'test message');
    expect(result).toContain('channel="whatsapp"');
  });

  it('preserves already-escaped HTML entities in content', () => {
    const result = formatUserMessage('discord', '&lt;script&gt;');
    expect(result).toBe('<user_message channel="discord">&lt;script&gt;</user_message>');
  });
});

// ---------------------------------------------------------------------------
// Test 12: StripResponseTags removes XML wrapper
// ---------------------------------------------------------------------------

describe('StripResponseTags removes XML wrapper', () => {
  it('removes bare <agent_response> and </agent_response> tags', () => {
    const result = stripResponseTags('<agent_response>Hello world</agent_response>');
    expect(result).toBe('Hello world');
  });

  it('removes <agent_response> with attributes', () => {
    const result = stripResponseTags('<agent_response version="2">Content here</agent_response>');
    expect(result).toBe('Content here');
  });

  it('trims whitespace from the result', () => {
    const result = stripResponseTags('<agent_response>  padded  </agent_response>');
    expect(result).toBe('padded');
  });

  it('returns content unchanged when no agent_response tags present', () => {
    const result = stripResponseTags('plain text response');
    expect(result).toBe('plain text response');
  });

  it('handles content with nested XML correctly', () => {
    const result = stripResponseTags(
      '<agent_response>Here is some <code>code</code> for you.</agent_response>',
    );
    expect(result).toBe('Here is some <code>code</code> for you.');
  });

  it('extractPrefix returns part before colon', () => {
    expect(extractPrefix('discord:123')).toBe('discord');
    expect(extractPrefix('whatsapp:+1234')).toBe('whatsapp');
    expect(extractPrefix('nocolon')).toBe('nocolon');
  });
});
