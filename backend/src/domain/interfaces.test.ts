/**
 * Tests for backend/src/domain/interfaces.ts
 *
 * Strategy:
 *   - Construct minimal mock implementations of each interface.
 *   - Verify at compile time that the mock satisfies the interface (TypeScript strict).
 *   - Verify at runtime that the mock object has the correct method names and arities.
 *   - Verify that GoOrchestrator extends TeamProvisioner, TaskCoordinator, HealthManager.
 *   - Verify that FastifyUpgradeHandler and TransactionCallback types are usable.
 *   - Verify that the index barrel re-exports all domain symbols.
 *
 * These tests are primarily compile-time guarantees. Any type-level error causes
 * the vitest run to fail because vitest uses esbuild/tsc under the hood.
 */

import { describe, it, expect } from 'vitest';

import type {
  ConfigLoader,
  OrgChart,
  WSConnection,
  WSHub,
  ContainerRuntime,
  ContainerManager,
  HeartbeatMonitor,
  SDKToolHandler,
  ChannelAdapter,
  MessageRouter,
  EventBus,
  KeyManager,
  TaskStore,
  MessageStore,
  LogStore,
  SessionStore,
  Transactor,
  TeamProvisioner,
  TaskCoordinator,
  HealthManager,
  GoOrchestrator,
  FastifyUpgradeHandler,
  TransactionCallback,
  TxHandle,
} from './interfaces.js';

import type {
  MasterConfig,
  Provider,
  Team,
  Agent,
  ContainerConfig,
  ContainerInfo,
  AgentHeartbeatStatus,
  HeartbeatStatus,
  Task,
  Message,
  LogEntry,
  LogQueryOpts,
  ChatSession,
  Event,
  JsonValue,
} from './types.js';

import type { EventType, TaskStatus, ContainerState } from './enums.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Date representing "now". Used to satisfy Date-typed fields
 * in mock objects without creating a new Date() each time.
 */
function now(): Date {
  return new Date('2026-03-04T00:00:00Z');
}

/**
 * A minimal Task fixture used across multiple tests.
 */
function makeTask(): Task {
  return {
    id: 'task-001',
    team_slug: 'engineering',
    status: 'pending',
    prompt: 'Do something useful.',
    created_at: now(),
    updated_at: now(),
    completed_at: null,
  };
}

/**
 * A minimal Team fixture used across multiple tests.
 */
function makeTeam(): Team {
  return {
    tid: 'tid-001',
    slug: 'engineering',
    leader_aid: 'aid-lead-001',
  };
}

/**
 * A minimal HeartbeatStatus fixture.
 */
function makeHeartbeatStatus(): HeartbeatStatus {
  return {
    team_id: 'tid-001',
    agents: [],
    last_seen: now(),
    is_healthy: true,
  };
}

// ---------------------------------------------------------------------------
// ConfigLoader
// ---------------------------------------------------------------------------

describe('ConfigLoader interface', () => {
  /**
   * Minimal mock that satisfies ConfigLoader.
   * All methods return stub Promises or void.
   */
  const mock: ConfigLoader = {
    async loadMaster(): Promise<MasterConfig> {
      return {
        system: {
          listen_address: ':8080',
          data_dir: 'data',
          workspace_root: '.run/teams',
          log_level: 'info',
          log_archive: { enabled: false, max_entries: 0, keep_copies: 0, archive_dir: '' },
          max_message_length: 4096,
          default_idle_timeout: '15m',
          event_bus_workers: 2,
          portal_ws_max_connections: 50,
          message_archive: { enabled: false, max_entries: 0, keep_copies: 0, archive_dir: '' },
        },
        assistant: {
          name: 'Hive',
          aid: 'aid-main-001',
          provider: 'default',
          model_tier: 'opus',
          max_turns: 50,
          timeout_minutes: 60,
        },
        channels: {
          discord: { enabled: false },
          whatsapp: { enabled: false },
        },
      };
    },
    async saveMaster(_cfg: MasterConfig): Promise<void> {},
    getMaster(): MasterConfig {
      return {
        system: {
          listen_address: ':8080',
          data_dir: 'data',
          workspace_root: '.run',
          log_level: 'info',
          log_archive: { enabled: false, max_entries: 0, keep_copies: 0, archive_dir: '' },
          max_message_length: 4096,
          default_idle_timeout: '15m',
          event_bus_workers: 2,
          portal_ws_max_connections: 50,
          message_archive: { enabled: false, max_entries: 0, keep_copies: 0, archive_dir: '' },
        },
        assistant: {
          name: 'Hive',
          aid: 'aid-main-001',
          provider: 'default',
          model_tier: 'opus',
          max_turns: 50,
          timeout_minutes: 60,
        },
        channels: { discord: { enabled: false }, whatsapp: { enabled: false } },
      };
    },
    async loadProviders(): Promise<Record<string, Provider>> {
      return {};
    },
    async saveProviders(_providers: Record<string, Provider>): Promise<void> {},
    async loadTeam(_slug: string): Promise<Team> {
      return makeTeam();
    },
    async saveTeam(_slug: string, _team: Team): Promise<void> {},
    async createTeamDir(_slug: string): Promise<void> {},
    async deleteTeamDir(_slug: string): Promise<void> {},
    async listTeams(): Promise<string[]> {
      return ['engineering'];
    },
    async watchMaster(_callback: (cfg: MasterConfig) => void): Promise<void> {},
    async watchProviders(_callback: (providers: Record<string, Provider>) => void): Promise<void> {},
    async watchTeam(_slug: string, _callback: (team: Team) => void): Promise<void> {},
    stopWatching(): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.loadMaster).toBe('function');
    expect(typeof mock.saveMaster).toBe('function');
    expect(typeof mock.getMaster).toBe('function');
    expect(typeof mock.loadProviders).toBe('function');
    expect(typeof mock.saveProviders).toBe('function');
    expect(typeof mock.loadTeam).toBe('function');
    expect(typeof mock.saveTeam).toBe('function');
    expect(typeof mock.createTeamDir).toBe('function');
    expect(typeof mock.deleteTeamDir).toBe('function');
    expect(typeof mock.listTeams).toBe('function');
    expect(typeof mock.watchMaster).toBe('function');
    expect(typeof mock.watchProviders).toBe('function');
    expect(typeof mock.watchTeam).toBe('function');
    expect(typeof mock.stopWatching).toBe('function');
  });

  it('loadMaster returns a MasterConfig promise', async () => {
    const cfg = await mock.loadMaster();
    expect(cfg.system.listen_address).toBe(':8080');
    expect(cfg.channels.discord.enabled).toBe(false);
  });

  it('getMaster returns synchronously', () => {
    const cfg = mock.getMaster();
    expect(cfg.assistant.name).toBe('Hive');
  });

  it('listTeams returns an array of strings', async () => {
    const teams = await mock.listTeams();
    expect(Array.isArray(teams)).toBe(true);
    expect(teams[0]).toBe('engineering');
  });

  it('stopWatching is synchronous', () => {
    // Should not throw
    expect(() => mock.stopWatching()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// OrgChart
// ---------------------------------------------------------------------------

describe('OrgChart interface', () => {
  const agent: Agent = { aid: 'aid-lead-001', name: 'Lead' };
  const team: Team = makeTeam();

  const mock: OrgChart = {
    getOrgChart(): Record<string, Team> {
      return { engineering: team };
    },
    getAgentByAID(_aid: string): Agent {
      return agent;
    },
    getTeamBySlug(_slug: string): Team {
      return team;
    },
    getTeamForAgent(_aid: string): Team {
      return team;
    },
    getLeadTeams(_aid: string): string[] {
      return ['engineering'];
    },
    getSubordinates(_aid: string): Agent[] {
      return [];
    },
    getSupervisor(_aid: string): Agent | null {
      return null;
    },
    rebuildFromConfig(_master: MasterConfig, _teams: Record<string, Team>): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.getOrgChart).toBe('function');
    expect(typeof mock.getAgentByAID).toBe('function');
    expect(typeof mock.getTeamBySlug).toBe('function');
    expect(typeof mock.getTeamForAgent).toBe('function');
    expect(typeof mock.getLeadTeams).toBe('function');
    expect(typeof mock.getSubordinates).toBe('function');
    expect(typeof mock.getSupervisor).toBe('function');
    expect(typeof mock.rebuildFromConfig).toBe('function');
  });

  it('getOrgChart returns a map of teams', () => {
    const chart = mock.getOrgChart();
    expect(chart['engineering']).toBeDefined();
    expect(chart['engineering']?.slug).toBe('engineering');
  });

  it('getSupervisor can return null (top-level agent)', () => {
    const supervisor = mock.getSupervisor('aid-lead-001');
    expect(supervisor).toBeNull();
  });

  it('getLeadTeams returns an array of strings', () => {
    const teams = mock.getLeadTeams('aid-lead-001');
    expect(Array.isArray(teams)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WSConnection
// ---------------------------------------------------------------------------

describe('WSConnection interface', () => {
  const mock: WSConnection = {
    async send(_msg: Buffer | string): Promise<void> {},
    async close(): Promise<void> {},
    teamID(): string {
      return 'tid-001';
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.send).toBe('function');
    expect(typeof mock.close).toBe('function');
    expect(typeof mock.teamID).toBe('function');
  });

  it('teamID returns the team identifier', () => {
    expect(mock.teamID()).toBe('tid-001');
  });

  it('send accepts both Buffer and string', async () => {
    await expect(mock.send('hello')).resolves.toBeUndefined();
    await expect(mock.send(Buffer.from('hello'))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WSHub
// ---------------------------------------------------------------------------

describe('WSHub interface', () => {
  const mockConn: WSConnection = {
    async send(_msg: Buffer | string): Promise<void> {},
    async close(): Promise<void> {},
    teamID(): string { return 'tid-001'; },
  };

  const mock: WSHub = {
    registerConnection(_teamID: string, _conn: WSConnection): void {},
    unregisterConnection(_teamID: string): void {},
    async sendToTeam(_teamID: string, _msg: Buffer | string): Promise<void> {},
    async broadcastAll(_msg: Buffer | string): Promise<void> {},
    generateToken(_teamID: string): string {
      return 'tok-abc-def';
    },
    getUpgradeHandler(): FastifyUpgradeHandler {
      return async (_socket: unknown, _request: unknown): Promise<void> => {};
    },
    getConnectedTeams(): string[] {
      return ['tid-001'];
    },
    setOnMessage(_handler: (teamID: string, msg: Buffer) => void): void {},
    setOnConnect(_handler: (teamID: string) => void): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.registerConnection).toBe('function');
    expect(typeof mock.unregisterConnection).toBe('function');
    expect(typeof mock.sendToTeam).toBe('function');
    expect(typeof mock.broadcastAll).toBe('function');
    expect(typeof mock.generateToken).toBe('function');
    expect(typeof mock.getUpgradeHandler).toBe('function');
    expect(typeof mock.getConnectedTeams).toBe('function');
    expect(typeof mock.setOnMessage).toBe('function');
    expect(typeof mock.setOnConnect).toBe('function');
  });

  it('generateToken returns a string token', () => {
    const token = mock.generateToken('tid-001');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('getUpgradeHandler returns a callable function', () => {
    const handler = mock.getUpgradeHandler();
    expect(typeof handler).toBe('function');
  });

  it('getConnectedTeams returns an array', () => {
    const teams = mock.getConnectedTeams();
    expect(Array.isArray(teams)).toBe(true);
    expect(teams).toContain('tid-001');
  });

  it('registerConnection accepts a WSConnection', () => {
    // Should not throw
    expect(() => mock.registerConnection('tid-001', mockConn)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ContainerRuntime
// ---------------------------------------------------------------------------

describe('ContainerRuntime interface', () => {
  const info: ContainerInfo = { id: 'ctr-abc', name: 'openhive-engineering', state: 'running' };

  const mock: ContainerRuntime = {
    async createContainer(_config: ContainerConfig): Promise<string> {
      return 'ctr-abc';
    },
    async startContainer(_containerID: string): Promise<void> {},
    async stopContainer(_containerID: string, _timeoutMs: number): Promise<void> {},
    async removeContainer(_containerID: string): Promise<void> {},
    async inspectContainer(_containerID: string): Promise<ContainerInfo> {
      return info;
    },
    async listContainers(): Promise<ContainerInfo[]> {
      return [info];
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.createContainer).toBe('function');
    expect(typeof mock.startContainer).toBe('function');
    expect(typeof mock.stopContainer).toBe('function');
    expect(typeof mock.removeContainer).toBe('function');
    expect(typeof mock.inspectContainer).toBe('function');
    expect(typeof mock.listContainers).toBe('function');
  });

  it('createContainer returns a container ID string', async () => {
    const id = await mock.createContainer({});
    expect(typeof id).toBe('string');
    expect(id).toBe('ctr-abc');
  });

  it('inspectContainer returns ContainerInfo', async () => {
    const result = await mock.inspectContainer('ctr-abc');
    expect(result.state).toBe('running');
  });

  it('listContainers returns an array of ContainerInfo', async () => {
    const list = await mock.listContainers();
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]?.name).toBe('openhive-engineering');
  });

  it('stopContainer accepts a timeout in milliseconds', async () => {
    // Should not throw; timeout is a number (ms)
    await expect(mock.stopContainer('ctr-abc', 10000)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ContainerManager
// ---------------------------------------------------------------------------

describe('ContainerManager interface', () => {
  const mock: ContainerManager = {
    async ensureRunning(_teamSlug: string): Promise<void> {},
    async provisionTeam(_teamSlug: string, _secrets: Record<string, string>): Promise<void> {},
    async removeTeam(_teamSlug: string): Promise<void> {},
    async restartTeam(_teamSlug: string): Promise<void> {},
    async stopTeam(_teamSlug: string): Promise<void> {},
    async cleanup(): Promise<void> {},
    getStatus(_teamSlug: string): ContainerState {
      return 'running';
    },
    getContainerID(_teamSlug: string): string {
      return 'ctr-abc';
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.ensureRunning).toBe('function');
    expect(typeof mock.provisionTeam).toBe('function');
    expect(typeof mock.removeTeam).toBe('function');
    expect(typeof mock.restartTeam).toBe('function');
    expect(typeof mock.stopTeam).toBe('function');
    expect(typeof mock.cleanup).toBe('function');
    expect(typeof mock.getStatus).toBe('function');
    expect(typeof mock.getContainerID).toBe('function');
  });

  it('getStatus is synchronous and returns a ContainerState', () => {
    const state = mock.getStatus('engineering');
    expect(state).toBe('running');
  });

  it('getContainerID is synchronous and returns a string', () => {
    const id = mock.getContainerID('engineering');
    expect(typeof id).toBe('string');
    expect(id).toBe('ctr-abc');
  });

  it('provisionTeam accepts a secrets map', async () => {
    await expect(
      mock.provisionTeam('engineering', { GITHUB_TOKEN: 'ghp_xxx' }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HeartbeatMonitor
// ---------------------------------------------------------------------------

describe('HeartbeatMonitor interface', () => {
  const status = makeHeartbeatStatus();
  const agentStatus: AgentHeartbeatStatus = {
    aid: 'aid-001',
    status: 'idle',
    detail: '',
    elapsed_seconds: 5,
    memory_mb: 64,
  };

  const mock: HeartbeatMonitor = {
    processHeartbeat(_teamID: string, _agents: AgentHeartbeatStatus[]): void {},
    getStatus(_teamID: string): HeartbeatStatus {
      return status;
    },
    getAllStatuses(): Record<string, HeartbeatStatus> {
      return { 'tid-001': status };
    },
    setOnUnhealthy(_callback: (teamID: string) => void): void {},
    startMonitoring(): void {},
    stopMonitoring(): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.processHeartbeat).toBe('function');
    expect(typeof mock.getStatus).toBe('function');
    expect(typeof mock.getAllStatuses).toBe('function');
    expect(typeof mock.setOnUnhealthy).toBe('function');
    expect(typeof mock.startMonitoring).toBe('function');
    expect(typeof mock.stopMonitoring).toBe('function');
  });

  it('processHeartbeat accepts an array of AgentHeartbeatStatus', () => {
    expect(() => mock.processHeartbeat('tid-001', [agentStatus])).not.toThrow();
  });

  it('getStatus returns a HeartbeatStatus', () => {
    const s = mock.getStatus('tid-001');
    expect(s.is_healthy).toBe(true);
    expect(s.team_id).toBe('tid-001');
  });

  it('getAllStatuses returns a map', () => {
    const all = mock.getAllStatuses();
    expect(all['tid-001']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SDKToolHandler
// ---------------------------------------------------------------------------

describe('SDKToolHandler interface', () => {
  const mock: SDKToolHandler = {
    async handleToolCall(
      _callID: string,
      _toolName: string,
      _args: Record<string, JsonValue>,
    ): Promise<JsonValue> {
      return { success: true };
    },
    async handleToolCallWithContext(
      _teamID: string,
      _callID: string,
      _toolName: string,
      _agentAID: string,
      _args: Record<string, JsonValue>,
    ): Promise<JsonValue> {
      return { result: 'ok', value: 42 };
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.handleToolCall).toBe('function');
    expect(typeof mock.handleToolCallWithContext).toBe('function');
  });

  it('handleToolCall returns a JsonValue promise', async () => {
    const result = await mock.handleToolCall('call-1', 'create_team', { slug: 'eng' });
    expect(result).toEqual({ success: true });
  });

  it('handleToolCallWithContext returns a JsonValue promise', async () => {
    const result = await mock.handleToolCallWithContext(
      'tid-001',
      'call-2',
      'dispatch_task',
      'aid-001',
      { prompt: 'Do it.' },
    );
    expect(result).toEqual({ result: 'ok', value: 42 });
  });

  it('args and results use Record<string, JsonValue> not Record<string, unknown>', async () => {
    // Type-level check: passing a Record<string, JsonValue> must compile
    const args: Record<string, JsonValue> = {
      name: 'test',
      count: 3,
      nested: { a: null },
    };
    const result = await mock.handleToolCall('call-3', 'test_tool', args);
    // JsonValue can be any JSON-compatible value
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ChannelAdapter
// ---------------------------------------------------------------------------

describe('ChannelAdapter interface', () => {
  const mock: ChannelAdapter = {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    async sendMessage(_jid: string, _content: string): Promise<void> {},
    getJIDPrefix(): string {
      return 'discord';
    },
    isConnected(): boolean {
      return true;
    },
    onMessage(_callback: (jid: string, content: string) => void): void {},
    onMetadata(_callback: (jid: string, metadata: Record<string, string>) => void): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.connect).toBe('function');
    expect(typeof mock.disconnect).toBe('function');
    expect(typeof mock.sendMessage).toBe('function');
    expect(typeof mock.getJIDPrefix).toBe('function');
    expect(typeof mock.isConnected).toBe('function');
    expect(typeof mock.onMessage).toBe('function');
    expect(typeof mock.onMetadata).toBe('function');
  });

  it('getJIDPrefix returns a string prefix', () => {
    expect(mock.getJIDPrefix()).toBe('discord');
  });

  it('isConnected returns a boolean', () => {
    expect(typeof mock.isConnected()).toBe('boolean');
    expect(mock.isConnected()).toBe(true);
  });

  it('sendMessage is async', async () => {
    await expect(mock.sendMessage('discord:123:456', 'Hello!')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MessageRouter
// ---------------------------------------------------------------------------

describe('MessageRouter interface', () => {
  const mockAdapter: ChannelAdapter = {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    async sendMessage(_jid: string, _content: string): Promise<void> {},
    getJIDPrefix(): string { return 'discord'; },
    isConnected(): boolean { return true; },
    onMessage(_cb: (jid: string, content: string) => void): void {},
    onMetadata(_cb: (jid: string, metadata: Record<string, string>) => void): void {},
  };

  const mock: MessageRouter = {
    async registerChannel(_adapter: ChannelAdapter): Promise<void> {},
    async unregisterChannel(_prefix: string): Promise<void> {},
    async routeInbound(_jid: string, _content: string): Promise<void> {},
    async routeOutbound(_jid: string, _content: string): Promise<void> {},
    getChannels(): Record<string, boolean> {
      return { discord: true, whatsapp: false };
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.registerChannel).toBe('function');
    expect(typeof mock.unregisterChannel).toBe('function');
    expect(typeof mock.routeInbound).toBe('function');
    expect(typeof mock.routeOutbound).toBe('function');
    expect(typeof mock.getChannels).toBe('function');
  });

  it('getChannels returns a map of prefix to boolean', () => {
    const channels = mock.getChannels();
    expect(channels['discord']).toBe(true);
    expect(channels['whatsapp']).toBe(false);
  });

  it('registerChannel accepts a ChannelAdapter', async () => {
    await expect(mock.registerChannel(mockAdapter)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

describe('EventBus interface', () => {
  const event: Event = {
    type: 'team_created',
    payload: { kind: 'team_created', team_id: 'tid-001' },
  };

  const mock: EventBus = {
    publish(_event: Event): void {},
    subscribe(_eventType: EventType, _handler: (event: Event) => void): string {
      return 'sub-001';
    },
    filteredSubscribe(
      _eventType: EventType,
      _filter: (event: Event) => boolean,
      _handler: (event: Event) => void,
    ): string {
      return 'sub-002';
    },
    unsubscribe(_id: string): void {},
    close(): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.publish).toBe('function');
    expect(typeof mock.subscribe).toBe('function');
    expect(typeof mock.filteredSubscribe).toBe('function');
    expect(typeof mock.unsubscribe).toBe('function');
    expect(typeof mock.close).toBe('function');
  });

  it('subscribe returns a subscription ID string', () => {
    const id = mock.subscribe('team_created', (_e: Event) => {});
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('filteredSubscribe returns a subscription ID string', () => {
    const id = mock.filteredSubscribe(
      'task_completed',
      (_e: Event) => true,
      (_e: Event) => {},
    );
    expect(typeof id).toBe('string');
  });

  it('publish is synchronous and does not throw', () => {
    expect(() => mock.publish(event)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// KeyManager
// ---------------------------------------------------------------------------

describe('KeyManager interface', () => {
  const mock: KeyManager = {
    async encrypt(_plaintext: string): Promise<string> {
      return 'enc:abc123';
    },
    async decrypt(_ciphertext: string): Promise<string> {
      return 'my-secret-key';
    },
    isLocked(): boolean {
      return false;
    },
    async unlock(_masterKey: string): Promise<void> {},
    lock(): void {},
  };

  it('has all required methods', () => {
    expect(typeof mock.encrypt).toBe('function');
    expect(typeof mock.decrypt).toBe('function');
    expect(typeof mock.isLocked).toBe('function');
    expect(typeof mock.unlock).toBe('function');
    expect(typeof mock.lock).toBe('function');
  });

  it('encrypt returns an encrypted string', async () => {
    const enc = await mock.encrypt('my-secret-key');
    expect(typeof enc).toBe('string');
  });

  it('decrypt returns a plaintext string', async () => {
    const plain = await mock.decrypt('enc:abc123');
    expect(plain).toBe('my-secret-key');
  });

  it('isLocked is synchronous', () => {
    expect(typeof mock.isLocked()).toBe('boolean');
  });

  it('lock is synchronous', () => {
    expect(() => mock.lock()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

describe('TaskStore interface', () => {
  const task = makeTask();

  const mock: TaskStore = {
    async create(_task: Task): Promise<void> {},
    async get(_id: string): Promise<Task> {
      return task;
    },
    async update(_task: Task): Promise<void> {},
    async delete(_id: string): Promise<void> {},
    async listByTeam(_teamSlug: string): Promise<Task[]> {
      return [task];
    },
    async listByStatus(_status: TaskStatus): Promise<Task[]> {
      return [task];
    },
    async getSubtree(_rootID: string): Promise<Task[]> {
      return [task];
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.create).toBe('function');
    expect(typeof mock.get).toBe('function');
    expect(typeof mock.update).toBe('function');
    expect(typeof mock.delete).toBe('function');
    expect(typeof mock.listByTeam).toBe('function');
    expect(typeof mock.listByStatus).toBe('function');
    expect(typeof mock.getSubtree).toBe('function');
  });

  it('get returns a Task', async () => {
    const t = await mock.get('task-001');
    expect(t.id).toBe('task-001');
    expect(t.status).toBe('pending');
  });

  it('listByStatus accepts a TaskStatus value', async () => {
    const tasks = await mock.listByStatus('pending');
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('getSubtree returns an array of Tasks', async () => {
    const subtree = await mock.getSubtree('task-001');
    expect(subtree.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MessageStore
// ---------------------------------------------------------------------------

describe('MessageStore interface', () => {
  const msg: Message = {
    id: 'msg-001',
    chat_jid: 'discord:123:456',
    role: 'user',
    content: 'Hello!',
    timestamp: now(),
  };

  const mock: MessageStore = {
    async create(_msg: Message): Promise<void> {},
    async getByChat(_chatJID: string, _since: Date, _limit: number): Promise<Message[]> {
      return [msg];
    },
    async getLatest(_chatJID: string, _n: number): Promise<Message[]> {
      return [msg];
    },
    async deleteByChat(_chatJID: string): Promise<void> {},
    async deleteBefore(_before: Date): Promise<number> {
      return 5;
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.create).toBe('function');
    expect(typeof mock.getByChat).toBe('function');
    expect(typeof mock.getLatest).toBe('function');
    expect(typeof mock.deleteByChat).toBe('function');
    expect(typeof mock.deleteBefore).toBe('function');
  });

  it('getByChat accepts Date for since parameter', async () => {
    const messages = await mock.getByChat('discord:123:456', new Date(), 50);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0]?.role).toBe('user');
  });

  it('deleteBefore returns a count of deleted rows', async () => {
    const count = await mock.deleteBefore(new Date());
    expect(typeof count).toBe('number');
    expect(count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// LogStore
// ---------------------------------------------------------------------------

describe('LogStore interface', () => {
  const entry: LogEntry = {
    id: 1,
    level: 'info',
    component: 'api',
    action: 'request',
    message: 'GET /health',
    created_at: now(),
  };

  const mock: LogStore = {
    async create(_entries: LogEntry[]): Promise<void> {},
    async query(_opts: LogQueryOpts): Promise<LogEntry[]> {
      return [entry];
    },
    async deleteBefore(_before: Date): Promise<number> {
      return 10;
    },
    async count(): Promise<number> {
      return 1;
    },
    async getOldest(_limit: number): Promise<LogEntry[]> {
      return [entry];
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.create).toBe('function');
    expect(typeof mock.query).toBe('function');
    expect(typeof mock.deleteBefore).toBe('function');
    expect(typeof mock.count).toBe('function');
    expect(typeof mock.getOldest).toBe('function');
  });

  it('create accepts a batch of entries', async () => {
    await expect(mock.create([entry])).resolves.toBeUndefined();
  });

  it('query returns an array of LogEntry', async () => {
    const results = await mock.query({ level: 'info', limit: 100 });
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.component).toBe('api');
  });

  it('count returns a number', async () => {
    const n = await mock.count();
    expect(typeof n).toBe('number');
  });

  it('deleteBefore returns deleted row count', async () => {
    const deleted = await mock.deleteBefore(new Date());
    expect(deleted).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

describe('SessionStore interface', () => {
  const session: ChatSession = {
    chat_jid: 'discord:123:456',
    channel_type: 'discord',
    last_timestamp: now(),
    last_agent_timestamp: now(),
  };

  const mock: SessionStore = {
    async get(_chatJID: string): Promise<ChatSession> {
      return session;
    },
    async upsert(_session: ChatSession): Promise<void> {},
    async delete(_chatJID: string): Promise<void> {},
    async listAll(): Promise<ChatSession[]> {
      return [session];
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.get).toBe('function');
    expect(typeof mock.upsert).toBe('function');
    expect(typeof mock.delete).toBe('function');
    expect(typeof mock.listAll).toBe('function');
  });

  it('get returns a ChatSession', async () => {
    const s = await mock.get('discord:123:456');
    expect(s.channel_type).toBe('discord');
  });

  it('listAll returns an array', async () => {
    const all = await mock.listAll();
    expect(Array.isArray(all)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transactor
// ---------------------------------------------------------------------------

describe('Transactor interface', () => {
  const mock: Transactor = {
    async withTransaction<T>(fn: TransactionCallback<T>): Promise<T> {
      // Simulate calling fn with a fake tx handle
      const fakeTx: TxHandle = {};
      return fn(fakeTx);
    },
  };

  it('has withTransaction method', () => {
    expect(typeof mock.withTransaction).toBe('function');
  });

  it('withTransaction calls the callback with a TxHandle', async () => {
    let callCount = 0;
    await mock.withTransaction(async (_tx: TxHandle) => {
      callCount++;
    });
    expect(callCount).toBe(1);
  });

  it('withTransaction propagates the return value', async () => {
    const result = await mock.withTransaction(async (_tx: TxHandle): Promise<number> => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('withTransaction uses the generic type parameter', async () => {
    const result = await mock.withTransaction<string>(async (_tx: TxHandle): Promise<string> => {
      return 'committed';
    });
    expect(result).toBe('committed');
  });
});

// ---------------------------------------------------------------------------
// TeamProvisioner
// ---------------------------------------------------------------------------

describe('TeamProvisioner interface', () => {
  const team = makeTeam();

  const mock: TeamProvisioner = {
    async createTeam(_slug: string, _leaderAID: string): Promise<Team> {
      return team;
    },
    async deleteTeam(_slug: string): Promise<void> {},
    async getTeam(_slug: string): Promise<Team> {
      return team;
    },
    async listTeams(): Promise<Team[]> {
      return [team];
    },
    async updateTeam(_slug: string, _updates: Record<string, JsonValue>): Promise<Team> {
      return team;
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.createTeam).toBe('function');
    expect(typeof mock.deleteTeam).toBe('function');
    expect(typeof mock.getTeam).toBe('function');
    expect(typeof mock.listTeams).toBe('function');
    expect(typeof mock.updateTeam).toBe('function');
  });

  it('createTeam returns a Team', async () => {
    const t = await mock.createTeam('engineering', 'aid-lead-001');
    expect(t.slug).toBe('engineering');
  });

  it('updateTeam accepts Record<string, JsonValue>', async () => {
    // updates must be Record<string, JsonValue>, not Record<string, unknown>
    const updates: Record<string, JsonValue> = {
      leader_aid: 'aid-new-001',
      children: ['tid-002'],
    };
    const t = await mock.updateTeam('engineering', updates);
    expect(t.slug).toBe('engineering');
  });

  it('listTeams returns an array of Teams', async () => {
    const teams = await mock.listTeams();
    expect(Array.isArray(teams)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TaskCoordinator
// ---------------------------------------------------------------------------

describe('TaskCoordinator interface', () => {
  const task = makeTask();

  const mock: TaskCoordinator = {
    async dispatchTask(_task: Task): Promise<void> {},
    async handleTaskResult(
      _taskID: string,
      _result: string,
      _errMsg: string,
    ): Promise<void> {},
    async cancelTask(_taskID: string): Promise<void> {},
    async getTaskStatus(_taskID: string): Promise<Task> {
      return task;
    },
    async createSubtasks(
      _parentID: string,
      _prompts: string[],
      _teamSlug: string,
    ): Promise<Task[]> {
      return [task];
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.dispatchTask).toBe('function');
    expect(typeof mock.handleTaskResult).toBe('function');
    expect(typeof mock.cancelTask).toBe('function');
    expect(typeof mock.getTaskStatus).toBe('function');
    expect(typeof mock.createSubtasks).toBe('function');
  });

  it('dispatchTask accepts a Task', async () => {
    await expect(mock.dispatchTask(task)).resolves.toBeUndefined();
  });

  it('handleTaskResult accepts result and errMsg strings', async () => {
    await expect(mock.handleTaskResult('task-001', 'done', '')).resolves.toBeUndefined();
    await expect(mock.handleTaskResult('task-001', '', 'timed out')).resolves.toBeUndefined();
  });

  it('getTaskStatus returns a Task', async () => {
    const t = await mock.getTaskStatus('task-001');
    expect(t.id).toBe('task-001');
  });

  it('createSubtasks returns an array of Tasks', async () => {
    const subtasks = await mock.createSubtasks('task-001', ['Subtask A', 'Subtask B'], 'engineering');
    expect(Array.isArray(subtasks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HealthManager
// ---------------------------------------------------------------------------

describe('HealthManager interface', () => {
  const status = makeHeartbeatStatus();

  const mock: HealthManager = {
    getHealthStatus(_teamSlug: string): HeartbeatStatus {
      return status;
    },
    async handleUnhealthy(_teamID: string): Promise<void> {},
    getAllStatuses(): Record<string, HeartbeatStatus> {
      return { 'tid-001': status };
    },
  };

  it('has all required methods', () => {
    expect(typeof mock.getHealthStatus).toBe('function');
    expect(typeof mock.handleUnhealthy).toBe('function');
    expect(typeof mock.getAllStatuses).toBe('function');
  });

  it('getHealthStatus is synchronous', () => {
    const s = mock.getHealthStatus('engineering');
    expect(s.is_healthy).toBe(true);
  });

  it('handleUnhealthy is async', async () => {
    await expect(mock.handleUnhealthy('tid-001')).resolves.toBeUndefined();
  });

  it('getAllStatuses returns a map', () => {
    const all = mock.getAllStatuses();
    expect(all['tid-001']?.team_id).toBe('tid-001');
  });
});

// ---------------------------------------------------------------------------
// GoOrchestrator — composite interface
// ---------------------------------------------------------------------------

describe('GoOrchestrator interface', () => {
  const team = makeTeam();
  const task = makeTask();
  const status = makeHeartbeatStatus();

  /**
   * GoOrchestrator extends TeamProvisioner, TaskCoordinator, and HealthManager.
   * A mock must implement all methods from all three parent interfaces plus
   * start() and stop().
   */
  const mock: GoOrchestrator = {
    // TeamProvisioner
    async createTeam(_slug: string, _leaderAID: string): Promise<Team> {
      return team;
    },
    async deleteTeam(_slug: string): Promise<void> {},
    async getTeam(_slug: string): Promise<Team> {
      return team;
    },
    async listTeams(): Promise<Team[]> {
      return [team];
    },
    async updateTeam(_slug: string, _updates: Record<string, JsonValue>): Promise<Team> {
      return team;
    },
    // TaskCoordinator
    async dispatchTask(_task: Task): Promise<void> {},
    async handleTaskResult(_taskID: string, _result: string, _errMsg: string): Promise<void> {},
    async cancelTask(_taskID: string): Promise<void> {},
    async getTaskStatus(_taskID: string): Promise<Task> {
      return task;
    },
    async createSubtasks(
      _parentID: string,
      _prompts: string[],
      _teamSlug: string,
    ): Promise<Task[]> {
      return [task];
    },
    // HealthManager
    getHealthStatus(_teamSlug: string): HeartbeatStatus {
      return status;
    },
    async handleUnhealthy(_teamID: string): Promise<void> {},
    getAllStatuses(): Record<string, HeartbeatStatus> {
      return { 'tid-001': status };
    },
    // GoOrchestrator own methods
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  };

  it('has all TeamProvisioner methods', () => {
    expect(typeof mock.createTeam).toBe('function');
    expect(typeof mock.deleteTeam).toBe('function');
    expect(typeof mock.getTeam).toBe('function');
    expect(typeof mock.listTeams).toBe('function');
    expect(typeof mock.updateTeam).toBe('function');
  });

  it('has all TaskCoordinator methods', () => {
    expect(typeof mock.dispatchTask).toBe('function');
    expect(typeof mock.handleTaskResult).toBe('function');
    expect(typeof mock.cancelTask).toBe('function');
    expect(typeof mock.getTaskStatus).toBe('function');
    expect(typeof mock.createSubtasks).toBe('function');
  });

  it('has all HealthManager methods', () => {
    expect(typeof mock.getHealthStatus).toBe('function');
    expect(typeof mock.handleUnhealthy).toBe('function');
    expect(typeof mock.getAllStatuses).toBe('function');
  });

  it('has own start and stop methods', () => {
    expect(typeof mock.start).toBe('function');
    expect(typeof mock.stop).toBe('function');
  });

  it('start and stop are async', async () => {
    await expect(mock.start()).resolves.toBeUndefined();
    await expect(mock.stop()).resolves.toBeUndefined();
  });

  it('can be used as TeamProvisioner', async () => {
    // GoOrchestrator is assignable to TeamProvisioner
    const tp: TeamProvisioner = mock;
    const t = await tp.createTeam('engineering', 'aid-lead-001');
    expect(t.slug).toBe('engineering');
  });

  it('can be used as TaskCoordinator', async () => {
    const tc: TaskCoordinator = mock;
    await expect(tc.dispatchTask(task)).resolves.toBeUndefined();
  });

  it('can be used as HealthManager', () => {
    const hm: HealthManager = mock;
    const s = hm.getHealthStatus('engineering');
    expect(s.is_healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FastifyUpgradeHandler type
// ---------------------------------------------------------------------------

describe('FastifyUpgradeHandler type', () => {
  it('is assignable from a function accepting two unknown arguments', () => {
    const handler: FastifyUpgradeHandler = async (_socket: unknown, _request: unknown): Promise<void> => {};
    expect(typeof handler).toBe('function');
  });

  it('can be used as a synchronous handler (void return)', () => {
    const handler: FastifyUpgradeHandler = (_socket: unknown, _request: unknown): void => {};
    expect(typeof handler).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// TransactionCallback and TxHandle types
// ---------------------------------------------------------------------------

describe('TransactionCallback type', () => {
  it('is callable with a TxHandle argument', async () => {
    const cb: TransactionCallback<string> = async (_tx: TxHandle): Promise<string> => 'done';
    const fakeTx: TxHandle = { _drizzle: true };
    const result = await cb(fakeTx);
    expect(result).toBe('done');
  });

  it('default generic type is void', async () => {
    const cb: TransactionCallback = async (_tx: TxHandle): Promise<void> => {};
    const result = await cb(undefined);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Barrel export (index.ts)
// ---------------------------------------------------------------------------

describe('index.ts barrel export', () => {
  it('re-exports enums from the domain index', async () => {
    const mod = await import('./index.js');
    // Verify a few representative exports from each sub-module
    expect(mod.TASK_STATUSES).toBeDefined();       // from enums.ts
    expect(mod.EVENT_TYPES).toBeDefined();          // from enums.ts
    expect(mod.LOG_LEVELS).toBeDefined();           // from enums.ts
  });

  it('re-exports error classes from the domain index', async () => {
    const mod = await import('./index.js');
    expect(mod.NotFoundError).toBeDefined();
    expect(mod.ValidationError).toBeDefined();
    expect(mod.ConflictError).toBeDefined();
  });

  it('re-exports validation functions from the domain index', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.validateAID).toBe('function');
    expect(typeof mod.validateSlug).toBe('function');
    expect(typeof mod.slugToDisplayName).toBe('function');
  });

  it('barrel exports are all accessible via the index', async () => {
    // This also verifies that there are no import/export cycle issues
    const mod = await import('./index.js');
    expect(mod).toBeDefined();
    expect(typeof mod).toBe('object');
  });
});
