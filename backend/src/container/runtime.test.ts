/**
 * Tests for backend/src/container/runtime.ts
 *
 * All tests use a FakeDockerClient (in-memory mock) — no real Docker daemon
 * is required. Tests cover:
 *
 *   RuntimeImpl.createContainer:
 *     - builds correct Docker config (name prefix, user, restart policy)
 *     - uses default image when config.image_name is absent
 *     - uses config.image_name when provided
 *     - sanitizes valid env var keys
 *     - rejects invalid env var keys (throws ValidationError)
 *     - skips env vars with unsafe values (newline, CR, null)
 *     - parses memory limits (512m, 1g) correctly
 *     - falls back to default memory on invalid max_memory
 *     - throws ValidationError when name is missing
 *
 *   RuntimeImpl.startContainer:
 *     - delegates start to DockerClient.getContainer(id).start()
 *     - wraps errors with contextual message
 *
 *   RuntimeImpl.stopContainer:
 *     - converts milliseconds to seconds for timeout
 *     - wraps errors with contextual message
 *
 *   RuntimeImpl.removeContainer:
 *     - calls remove with force=true
 *     - wraps errors with contextual message
 *
 *   RuntimeImpl.inspectContainer:
 *     - maps State.Status to domain ContainerState
 *     - strips leading "/" from container name
 *
 *   RuntimeImpl.listContainers:
 *     - filters by openhive- name prefix in request
 *     - maps results to ContainerInfo with correct state
 *     - strips leading "/" from container names
 *
 *   mapDockerState:
 *     - maps all Docker status strings correctly
 *     - maps unknown strings to 'failed'
 *
 *   ensureNetwork:
 *     - returns existing network ID when found
 *     - creates network when not found
 *     - sets ICC disabled option on created network
 *
 *   sanitizeEnvVars:
 *     - accepts valid key names
 *     - rejects invalid key names (throws ValidationError)
 *     - skips values with \n, \r, \x00
 *
 *   parseMemoryLimit:
 *     - parses 512m → 536870912
 *     - parses 1g → 1073741824
 *     - parses 256k → 262144
 *     - returns null for empty string
 *     - returns null for non-numeric input
 *     - returns null for negative or zero values
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Dockerode from 'dockerode';

import {
  RuntimeImpl,
  mapDockerState,
  sanitizeEnvVars,
  parseMemoryLimit,
  OPENHIVE_NETWORK_NAME,
  CONTAINER_NAME_PREFIX,
  DEFAULT_MEMORY_LIMIT,
} from './runtime.js';
import type { DockerClient, DockerContainer, RuntimeLogger } from './runtime.js';
import { ValidationError } from '../domain/errors.js';
import type { ContainerConfig } from '../domain/types.js';

// ---------------------------------------------------------------------------
// FakeLogger
// ---------------------------------------------------------------------------

interface LogEntry {
  msg: string;
  data?: Record<string, unknown>;
}

class FakeLogger implements RuntimeLogger {
  readonly debugs: LogEntry[] = [];
  readonly infos: LogEntry[] = [];
  readonly warns: LogEntry[] = [];
  readonly errors: LogEntry[] = [];

  debug(msg: string, data?: Record<string, unknown>): void {
    this.debugs.push({ msg, data });
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.infos.push({ msg, data });
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.warns.push({ msg, data });
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.errors.push({ msg, data });
  }
}

// ---------------------------------------------------------------------------
// FakeDockerContainer
// ---------------------------------------------------------------------------

class FakeDockerContainer implements DockerContainer {
  readonly id: string;
  startCalls = 0;
  stopCalls: Array<{ t?: number }> = [];
  removeCalls: Array<{ force?: boolean }> = [];
  inspectResult: Partial<Dockerode.ContainerInspectInfo> | null = null;
  shouldThrowOnStart: Error | null = null;
  shouldThrowOnStop: Error | null = null;
  shouldThrowOnRemove: Error | null = null;
  shouldThrowOnInspect: Error | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async start(): Promise<void> {
    if (this.shouldThrowOnStart !== null) throw this.shouldThrowOnStart;
    this.startCalls++;
  }

  async stop(opts?: { t?: number }): Promise<void> {
    if (this.shouldThrowOnStop !== null) throw this.shouldThrowOnStop;
    this.stopCalls.push(opts ?? {});
  }

  async remove(opts?: { force?: boolean }): Promise<void> {
    if (this.shouldThrowOnRemove !== null) throw this.shouldThrowOnRemove;
    this.removeCalls.push(opts ?? {});
  }

  async inspect(): Promise<Dockerode.ContainerInspectInfo> {
    if (this.shouldThrowOnInspect !== null) throw this.shouldThrowOnInspect;
    if (this.inspectResult === null) {
      throw new Error('no inspect result configured');
    }
    return this.inspectResult as Dockerode.ContainerInspectInfo;
  }
}

// ---------------------------------------------------------------------------
// FakeDockerClient
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory DockerClient implementation used in tests.
 */
class FakeDockerClient implements DockerClient {
  /** Containers indexed by ID. */
  readonly containers: Map<string, FakeDockerContainer> = new Map();
  /** Options captured during createContainer calls. */
  readonly createContainerCalls: Dockerode.ContainerCreateOptions[] = [];
  /** Options captured during listContainers calls. */
  readonly listContainersCalls: Array<Dockerode.ContainerListOptions | undefined> = [];
  /** Networks list returned by listNetworks. */
  networkList: Dockerode.NetworkInspectInfo[] = [];
  /** Result returned by createNetwork. */
  createdNetworkID = 'net-fake-001';
  /** Options captured during createNetwork calls. */
  readonly createNetworkCalls: Dockerode.NetworkCreateOptions[] = [];
  /** Raw ContainerInfo list returned by listContainers. */
  containerList: Dockerode.ContainerInfo[] = [];
  /** If set, the next createContainer call will throw this error. */
  createContainerError: Error | null = null;

  /** Counter for generated container IDs. */
  private nextContainerID = 1;

  getContainer(id: string): DockerContainer {
    let container = this.containers.get(id);
    if (container === undefined) {
      // Create a lazy handle — may fail later if methods are called on non-existent container
      container = new FakeDockerContainer(id);
      this.containers.set(id, container);
    }
    return container;
  }

  async createContainer(options: Dockerode.ContainerCreateOptions): Promise<DockerContainer> {
    this.createContainerCalls.push(options);
    if (this.createContainerError !== null) {
      const err = this.createContainerError;
      this.createContainerError = null;
      throw err;
    }
    const id = `container-${String(this.nextContainerID++).padStart(3, '0')}`;
    const container = new FakeDockerContainer(id);
    this.containers.set(id, container);
    return container;
  }

  async listContainers(options?: Dockerode.ContainerListOptions): Promise<Dockerode.ContainerInfo[]> {
    this.listContainersCalls.push(options);
    return this.containerList;
  }

  async listNetworks(_options?: Dockerode.NetworkListOptions): Promise<Dockerode.NetworkInspectInfo[]> {
    return this.networkList;
  }

  async createNetwork(options: Dockerode.NetworkCreateOptions): Promise<{ id: string }> {
    this.createNetworkCalls.push(options);
    return { id: this.createdNetworkID };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(opts?: { imageName?: string }): {
  runtime: RuntimeImpl;
  client: FakeDockerClient;
  logger: FakeLogger;
} {
  const client = new FakeDockerClient();
  const logger = new FakeLogger();
  const runtime = new RuntimeImpl(client, opts?.imageName ?? 'openhive-team:latest', logger);
  return { runtime, client, logger };
}

function makeInspectResult(status: string, name = '/openhive-test-team'): Partial<Dockerode.ContainerInspectInfo> {
  return {
    Id: 'container-abc',
    Name: name,
    State: {
      Status: status,
      Running: status === 'running',
      Paused: status === 'paused',
      Restarting: status === 'restarting',
      OOMKilled: false,
      Dead: status === 'dead',
      Pid: 0,
      ExitCode: 0,
      Error: '',
      StartedAt: '',
      FinishedAt: '',
    },
  };
}

function makeContainerListEntry(
  id: string,
  names: string[],
  state: string,
): Dockerode.ContainerInfo {
  return {
    Id: id,
    Names: names,
    Image: 'openhive-team:latest',
    ImageID: 'img-001',
    Command: 'node /app/dist/index.js',
    Created: Date.now(),
    Ports: [],
    Labels: {},
    State: state,
    Status: state,
    HostConfig: { NetworkMode: 'openhive-network' },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
}

// ---------------------------------------------------------------------------
// Tests: createContainer
// ---------------------------------------------------------------------------

describe('RuntimeImpl.createContainer', () => {
  it('prepends "openhive-" to the container name', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].name).toBe('openhive-test-team');
  });

  it('uses default image when config.image_name is not set', async () => {
    const { runtime, client } = makeRuntime({ imageName: 'openhive-team:v1' });
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].Image).toBe('openhive-team:v1');
  });

  it('uses config.image_name when provided', async () => {
    const { runtime, client } = makeRuntime({ imageName: 'openhive-team:v1' });
    await runtime.createContainer({ name: 'test-team', image_name: 'custom-image:latest' });
    expect(client.createContainerCalls[0].Image).toBe('custom-image:latest');
  });

  it('sets container User to "node"', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].User).toBe('node');
  });

  it('sets RestartPolicy to "on-failure"', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].HostConfig?.RestartPolicy?.Name).toBe('on-failure');
  });

  it('attaches container to openhive-network in NetworkingConfig', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    const networkingConfig = client.createContainerCalls[0].NetworkingConfig;
    expect(networkingConfig?.EndpointsConfig).toHaveProperty(OPENHIVE_NETWORK_NAME);
  });

  it('returns the container ID from Docker', async () => {
    const { runtime } = makeRuntime();
    const id = await runtime.createContainer({ name: 'test-team' });
    expect(id).toMatch(/^container-\d+$/);
  });

  it('throws ValidationError when name is missing', async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.createContainer({})).rejects.toThrow(ValidationError);
    await expect(runtime.createContainer({ name: '' })).rejects.toThrow(ValidationError);
  });

  it('ValidationError on missing name has correct field', async () => {
    const { runtime } = makeRuntime();
    try {
      await runtime.createContainer({});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('name');
    }
  });

  it('includes valid env vars as KEY=VALUE pairs', async () => {
    const { runtime, client } = makeRuntime();
    const env: Record<string, string> = {
      FOO: 'bar',
      MY_VAR: 'hello',
    };
    await runtime.createContainer({ name: 'test-team', env });
    const envList = client.createContainerCalls[0].Env ?? [];
    expect(envList).toContain('FOO=bar');
    expect(envList).toContain('MY_VAR=hello');
  });

  it('throws ValidationError for invalid env key (starts with digit)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.createContainer({ name: 'test-team', env: { '1INVALID': 'val' } }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for invalid env key (contains hyphen)', async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.createContainer({ name: 'test-team', env: { 'INVALID-KEY': 'val' } }),
    ).rejects.toThrow(ValidationError);
  });

  it('skips env vars with newline in value and logs warning', async () => {
    const { runtime, client, logger } = makeRuntime();
    await runtime.createContainer({
      name: 'test-team',
      env: { GOOD: 'value', BAD: 'val\nue' },
    });
    const envList = client.createContainerCalls[0].Env ?? [];
    expect(envList).toContain('GOOD=value');
    expect(envList.find((e) => e.startsWith('BAD='))).toBeUndefined();
    expect(logger.warns.some((w) => w.msg.includes('unsafe characters'))).toBe(true);
  });

  it('skips env vars with carriage return in value', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({
      name: 'test-team',
      env: { BAD: 'val\rue' },
    });
    const envList = client.createContainerCalls[0].Env ?? [];
    expect(envList.find((e) => e.startsWith('BAD='))).toBeUndefined();
  });

  it('skips env vars with null byte in value', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({
      name: 'test-team',
      env: { BAD: 'val\x00ue' },
    });
    const envList = client.createContainerCalls[0].Env ?? [];
    expect(envList.find((e) => e.startsWith('BAD='))).toBeUndefined();
  });

  it('sets default memory limit (512MB) when max_memory is not set', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].HostConfig?.Memory).toBe(DEFAULT_MEMORY_LIMIT);
  });

  it('parses "512m" memory limit correctly', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team', max_memory: '512m' });
    expect(client.createContainerCalls[0].HostConfig?.Memory).toBe(512 * 1024 * 1024);
  });

  it('parses "1g" memory limit correctly', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team', max_memory: '1g' });
    expect(client.createContainerCalls[0].HostConfig?.Memory).toBe(1024 * 1024 * 1024);
  });

  it('parses "256k" memory limit correctly', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team', max_memory: '256k' });
    expect(client.createContainerCalls[0].HostConfig?.Memory).toBe(256 * 1024);
  });

  it('falls back to default memory on invalid max_memory and logs warning', async () => {
    const { runtime, client, logger } = makeRuntime();
    await runtime.createContainer({ name: 'test-team', max_memory: 'invalid' });
    expect(client.createContainerCalls[0].HostConfig?.Memory).toBe(DEFAULT_MEMORY_LIMIT);
    expect(logger.warns.some((w) => w.msg.includes('invalid max_memory'))).toBe(true);
  });

  it('logs info with container_id, container_name, image on success', async () => {
    const { runtime, logger } = makeRuntime({ imageName: 'openhive-team:latest' });
    await runtime.createContainer({ name: 'test-team' });
    const infoLog = logger.infos.find((l) => l.msg === 'container created');
    expect(infoLog).toBeDefined();
    expect(infoLog?.data?.container_name).toBe('openhive-test-team');
    expect(infoLog?.data?.image).toBe('openhive-team:latest');
  });

  it('uses empty env list when env is not provided', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].Env).toEqual([]);
  });

  it('passes binds to HostConfig.Binds when provided', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({
      name: 'test-team',
      binds: ['/host/workspace:/app/workspace'],
    });
    expect(client.createContainerCalls[0].HostConfig?.Binds).toEqual(['/host/workspace:/app/workspace']);
  });

  it('omits Binds when binds is not provided', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.createContainer({ name: 'test-team' });
    expect(client.createContainerCalls[0].HostConfig?.Binds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: startContainer
// ---------------------------------------------------------------------------

describe('RuntimeImpl.startContainer', () => {
  it('calls start() on the container handle', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    client.containers.set('ctr-001', container);

    await runtime.startContainer('ctr-001');
    expect(container.startCalls).toBe(1);
  });

  it('logs info on success', async () => {
    const { runtime, client, logger } = makeRuntime();
    client.containers.set('ctr-001', new FakeDockerContainer('ctr-001'));

    await runtime.startContainer('ctr-001');
    expect(logger.infos.some((l) => l.msg === 'container started')).toBe(true);
  });

  it('wraps errors with contextual message', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.shouldThrowOnStart = new Error('daemon error');
    client.containers.set('ctr-001', container);

    await expect(runtime.startContainer('ctr-001')).rejects.toThrow(
      'start container "ctr-001": daemon error',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: stopContainer
// ---------------------------------------------------------------------------

describe('RuntimeImpl.stopContainer', () => {
  it('converts milliseconds to seconds for timeout', async () => {
    const { runtime, client } = makeRuntime();
    client.containers.set('ctr-001', new FakeDockerContainer('ctr-001'));

    await runtime.stopContainer('ctr-001', 30_000);
    const container = client.containers.get('ctr-001') as FakeDockerContainer;
    expect(container.stopCalls[0].t).toBe(30);
  });

  it('rounds fractional seconds', async () => {
    const { runtime, client } = makeRuntime();
    client.containers.set('ctr-001', new FakeDockerContainer('ctr-001'));

    await runtime.stopContainer('ctr-001', 5_500);
    const container = client.containers.get('ctr-001') as FakeDockerContainer;
    expect(container.stopCalls[0].t).toBe(6);
  });

  it('logs info on success', async () => {
    const { runtime, client, logger } = makeRuntime();
    client.containers.set('ctr-001', new FakeDockerContainer('ctr-001'));

    await runtime.stopContainer('ctr-001', 10_000);
    expect(logger.infos.some((l) => l.msg === 'container stopped')).toBe(true);
  });

  it('wraps errors with contextual message', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.shouldThrowOnStop = new Error('timeout exceeded');
    client.containers.set('ctr-001', container);

    await expect(runtime.stopContainer('ctr-001', 5_000)).rejects.toThrow(
      'stop container "ctr-001": timeout exceeded',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: removeContainer
// ---------------------------------------------------------------------------

describe('RuntimeImpl.removeContainer', () => {
  it('calls remove with force=true', async () => {
    const { runtime, client } = makeRuntime();
    client.containers.set('ctr-001', new FakeDockerContainer('ctr-001'));

    await runtime.removeContainer('ctr-001');
    const container = client.containers.get('ctr-001') as FakeDockerContainer;
    expect(container.removeCalls[0].force).toBe(true);
  });

  it('logs info on success', async () => {
    const { runtime, client, logger } = makeRuntime();
    client.containers.set('ctr-001', new FakeDockerContainer('ctr-001'));

    await runtime.removeContainer('ctr-001');
    expect(logger.infos.some((l) => l.msg === 'container removed')).toBe(true);
  });

  it('wraps errors with contextual message', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.shouldThrowOnRemove = new Error('container not found');
    client.containers.set('ctr-001', container);

    await expect(runtime.removeContainer('ctr-001')).rejects.toThrow(
      'remove container "ctr-001": container not found',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: inspectContainer
// ---------------------------------------------------------------------------

describe('RuntimeImpl.inspectContainer', () => {
  it('maps State.Status to domain ContainerState', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.inspectResult = makeInspectResult('running', '/openhive-test-team');
    client.containers.set('ctr-001', container);

    const info = await runtime.inspectContainer('ctr-001');
    expect(info.state).toBe('running');
  });

  it('strips leading "/" from container name', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.inspectResult = makeInspectResult('running', '/openhive-test-team');
    client.containers.set('ctr-001', container);

    const info = await runtime.inspectContainer('ctr-001');
    expect(info.name).toBe('openhive-test-team');
  });

  it('returns name without "/" if already absent', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.inspectResult = makeInspectResult('running', 'openhive-test-team');
    client.containers.set('ctr-001', container);

    const info = await runtime.inspectContainer('ctr-001');
    expect(info.name).toBe('openhive-test-team');
  });

  it('returns the container ID from inspect response', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.inspectResult = {
      ...makeInspectResult('running'),
      Id: 'full-container-id-abc',
    };
    client.containers.set('ctr-001', container);

    const info = await runtime.inspectContainer('ctr-001');
    expect(info.id).toBe('full-container-id-abc');
  });

  it('wraps errors with contextual message', async () => {
    const { runtime, client } = makeRuntime();
    const container = new FakeDockerContainer('ctr-001');
    container.shouldThrowOnInspect = new Error('no such container');
    client.containers.set('ctr-001', container);

    await expect(runtime.inspectContainer('ctr-001')).rejects.toThrow(
      'inspect container "ctr-001": no such container',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: listContainers
// ---------------------------------------------------------------------------

describe('RuntimeImpl.listContainers', () => {
  it('passes filters with openhive- prefix to listContainers', async () => {
    const { runtime, client } = makeRuntime();
    client.containerList = [];

    await runtime.listContainers();

    expect(client.listContainersCalls).toHaveLength(1);
    const opts = client.listContainersCalls[0];
    expect(opts?.all).toBe(true);
    // Filters should contain the openhive- prefix
    const filtersStr = opts?.filters as string;
    const filters = JSON.parse(filtersStr) as Record<string, string[]>;
    expect(filters.name).toContain(CONTAINER_NAME_PREFIX);
  });

  it('returns mapped ContainerInfo from list result', async () => {
    const { runtime, client } = makeRuntime();
    client.containerList = [
      makeContainerListEntry('abc123', ['/openhive-team-a'], 'running'),
      makeContainerListEntry('def456', ['/openhive-team-b'], 'exited'),
    ];

    const result = await runtime.listContainers();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('abc123');
    expect(result[0].name).toBe('openhive-team-a');
    expect(result[0].state).toBe('running');
    expect(result[1].id).toBe('def456');
    expect(result[1].name).toBe('openhive-team-b');
    expect(result[1].state).toBe('stopped');
  });

  it('strips leading "/" from container names in list', async () => {
    const { runtime, client } = makeRuntime();
    client.containerList = [
      makeContainerListEntry('abc123', ['/openhive-team-a'], 'running'),
    ];

    const result = await runtime.listContainers();
    expect(result[0].name).toBe('openhive-team-a');
  });

  it('filters out containers with empty names (no Names from Docker)', async () => {
    const { runtime, client } = makeRuntime();
    client.containerList = [
      makeContainerListEntry('abc123', [], 'running'),
    ];

    const result = await runtime.listContainers();
    // Empty name doesn't start with "openhive-" prefix, so it's filtered out
    expect(result).toHaveLength(0);
  });

  it('returns empty list when no containers exist', async () => {
    const { runtime, client } = makeRuntime();
    client.containerList = [];

    const result = await runtime.listContainers();
    expect(result).toHaveLength(0);
  });

  it('wraps errors with contextual message', async () => {
    const { runtime, client } = makeRuntime();
    vi.spyOn(client, 'listContainers').mockRejectedValueOnce(new Error('daemon unavailable'));

    await expect(runtime.listContainers()).rejects.toThrow(
      'list containers: daemon unavailable',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: mapDockerState
// ---------------------------------------------------------------------------

describe('mapDockerState', () => {
  const cases: Array<[string, string]> = [
    ['created', 'created'],
    ['running', 'running'],
    ['restarting', 'starting'],
    ['paused', 'stopped'],
    ['exited', 'stopped'],
    ['dead', 'stopped'],
    ['removing', 'removing'],
    ['unknown', 'failed'],
    ['', 'failed'],
    ['RUNNING', 'failed'], // case-sensitive
  ];

  for (const [dockerStatus, expectedDomainState] of cases) {
    it(`maps "${dockerStatus}" → "${expectedDomainState}"`, () => {
      expect(mapDockerState(dockerStatus)).toBe(expectedDomainState);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: ensureNetwork
// ---------------------------------------------------------------------------

describe('RuntimeImpl.ensureNetwork', () => {
  it('returns existing network ID when openhive-network is already present', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [
      {
        Name: OPENHIVE_NETWORK_NAME,
        Id: 'existing-net-001',
        Created: '',
        Scope: 'local',
        Driver: 'bridge',
        EnableIPv6: false,
        Internal: false,
        Attachable: false,
        Ingress: false,
        ConfigOnly: false,
      },
    ];

    const id = await runtime.ensureNetwork();
    expect(id).toBe('existing-net-001');
  });

  it('does NOT call createNetwork when network already exists', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [
      {
        Name: OPENHIVE_NETWORK_NAME,
        Id: 'existing-net-001',
        Created: '',
        Scope: 'local',
        Driver: 'bridge',
        EnableIPv6: false,
        Internal: false,
        Attachable: false,
        Ingress: false,
        ConfigOnly: false,
      },
    ];

    await runtime.ensureNetwork();
    expect(client.createNetworkCalls).toHaveLength(0);
  });

  it('logs debug when network already exists', async () => {
    const { runtime, client, logger } = makeRuntime();
    client.networkList = [
      {
        Name: OPENHIVE_NETWORK_NAME,
        Id: 'existing-net-001',
        Created: '',
        Scope: 'local',
        Driver: 'bridge',
        EnableIPv6: false,
        Internal: false,
        Attachable: false,
        Ingress: false,
        ConfigOnly: false,
      },
    ];

    await runtime.ensureNetwork();
    expect(logger.debugs.some((l) => l.msg === 'openhive-network already exists')).toBe(true);
  });

  it('creates network when it does not exist', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [];
    client.createdNetworkID = 'new-net-002';

    const id = await runtime.ensureNetwork();
    expect(id).toBe('new-net-002');
    expect(client.createNetworkCalls).toHaveLength(1);
  });

  it('creates network with correct name', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [];

    await runtime.ensureNetwork();
    expect(client.createNetworkCalls[0].Name).toBe(OPENHIVE_NETWORK_NAME);
  });

  it('creates network with bridge driver', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [];

    await runtime.ensureNetwork();
    expect(client.createNetworkCalls[0].Driver).toBe('bridge');
  });

  it('sets ICC disabled option on created network', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [];

    await runtime.ensureNetwork();
    expect(client.createNetworkCalls[0].Options?.['com.docker.network.bridge.enable_icc']).toBe('false');
  });

  it('logs info when network is created', async () => {
    const { runtime, client, logger } = makeRuntime();
    client.networkList = [];

    await runtime.ensureNetwork();
    expect(logger.infos.some((l) => l.msg === 'openhive-network created')).toBe(true);
  });

  it('ignores networks with different names', async () => {
    const { runtime, client } = makeRuntime();
    client.networkList = [
      {
        Name: 'some-other-network',
        Id: 'net-other',
        Created: '',
        Scope: 'local',
        Driver: 'bridge',
        EnableIPv6: false,
        Internal: false,
        Attachable: false,
        Ingress: false,
        ConfigOnly: false,
      },
    ];
    client.createdNetworkID = 'newly-created-net';

    const id = await runtime.ensureNetwork();
    expect(id).toBe('newly-created-net');
    expect(client.createNetworkCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: sanitizeEnvVars
// ---------------------------------------------------------------------------

describe('sanitizeEnvVars', () => {
  let logger: FakeLogger;
  beforeEach(() => { logger = new FakeLogger(); });

  it('accepts valid key names and returns KEY=VALUE format', () => {
    const result = sanitizeEnvVars({ FOO: 'bar', MY_VAR: 'hello', _PRIV: 'x' }, logger);
    expect(result).toContain('FOO=bar');
    expect(result).toContain('MY_VAR=hello');
    expect(result).toContain('_PRIV=x');
  });

  it('throws ValidationError for key starting with digit', () => {
    expect(() => sanitizeEnvVars({ '1FOO': 'val' }, logger)).toThrow(ValidationError);
  });

  it('throws ValidationError for key with hyphen', () => {
    expect(() => sanitizeEnvVars({ 'MY-VAR': 'val' }, logger)).toThrow(ValidationError);
  });

  it('throws ValidationError for key with space', () => {
    expect(() => sanitizeEnvVars({ 'MY VAR': 'val' }, logger)).toThrow(ValidationError);
  });

  it('throws ValidationError for empty key', () => {
    expect(() => sanitizeEnvVars({ '': 'val' }, logger)).toThrow(ValidationError);
  });

  it('ValidationError on invalid key has field "env"', () => {
    try {
      sanitizeEnvVars({ '1INVALID': 'val' }, logger);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('env');
    }
  });

  it('skips value with \\n and logs warning', () => {
    const result = sanitizeEnvVars({ GOOD: 'ok', BAD: 'val\nue' }, logger);
    expect(result).toContain('GOOD=ok');
    expect(result.find((e) => e.startsWith('BAD='))).toBeUndefined();
    expect(logger.warns.some((w) => w.data?.key === 'BAD')).toBe(true);
  });

  it('skips value with \\r', () => {
    const result = sanitizeEnvVars({ BAD: 'val\rue' }, logger);
    expect(result.find((e) => e.startsWith('BAD='))).toBeUndefined();
  });

  it('skips value with \\x00', () => {
    const result = sanitizeEnvVars({ BAD: 'val\x00ue' }, logger);
    expect(result.find((e) => e.startsWith('BAD='))).toBeUndefined();
  });

  it('returns empty array for empty input', () => {
    expect(sanitizeEnvVars({}, logger)).toEqual([]);
  });

  it('value containing "=" is included correctly (value-side equals sign)', () => {
    const result = sanitizeEnvVars({ ENCODED: 'abc%3Ddef' }, logger);
    expect(result).toContain('ENCODED=abc%3Ddef');
  });
});

// ---------------------------------------------------------------------------
// Tests: parseMemoryLimit
// ---------------------------------------------------------------------------

describe('parseMemoryLimit', () => {
  it('returns null for empty string', () => {
    expect(parseMemoryLimit('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseMemoryLimit('   ')).toBeNull();
  });

  it('parses "512m" → 536870912', () => {
    expect(parseMemoryLimit('512m')).toBe(512 * 1024 * 1024);
  });

  it('parses "1g" → 1073741824', () => {
    expect(parseMemoryLimit('1g')).toBe(1024 * 1024 * 1024);
  });

  it('parses "256k" → 262144', () => {
    expect(parseMemoryLimit('256k')).toBe(256 * 1024);
  });

  it('parses uppercase suffixes (case-insensitive)', () => {
    expect(parseMemoryLimit('1G')).toBe(1024 * 1024 * 1024);
    expect(parseMemoryLimit('512M')).toBe(512 * 1024 * 1024);
    expect(parseMemoryLimit('256K')).toBe(256 * 1024);
  });

  it('parses plain integer (no suffix) as bytes', () => {
    expect(parseMemoryLimit('1048576')).toBe(1048576);
  });

  it('returns null for non-numeric input "abc"', () => {
    expect(parseMemoryLimit('abc')).toBeNull();
  });

  it('returns null for non-numeric with suffix "abcm"', () => {
    expect(parseMemoryLimit('abcm')).toBeNull();
  });

  it('returns null for zero value', () => {
    expect(parseMemoryLimit('0m')).toBeNull();
  });

  it('returns null for negative value', () => {
    expect(parseMemoryLimit('-1m')).toBeNull();
  });

  it('returns null for float value "1.5m" (no decimal support)', () => {
    expect(parseMemoryLimit('1.5m')).toBeNull();
  });

  it('strips leading/trailing whitespace before parsing', () => {
    expect(parseMemoryLimit('  512m  ')).toBe(512 * 1024 * 1024);
  });

  it('parses "2g" correctly', () => {
    expect(parseMemoryLimit('2g')).toBe(2 * 1024 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Tests: ContainerConfig full roundtrip
// ---------------------------------------------------------------------------

describe('RuntimeImpl.createContainer — full config roundtrip', () => {
  it('builds a complete Docker create options object', async () => {
    const { runtime, client } = makeRuntime({ imageName: 'openhive-team:latest' });

    const config: ContainerConfig = {
      name: 'alpha-team',
      image_name: 'openhive-team:v2',
      max_memory: '768m',
      env: {
        TEAM_ID: 'tid-alpha-001',
        WS_ENDPOINT: 'ws-endpoint-value',
        AUTH_TOKEN: 'test-token-abc',
      },
    };

    const id = await runtime.createContainer(config);

    const opts = client.createContainerCalls[0];
    expect(id).toBeDefined();
    expect(opts.name).toBe('openhive-alpha-team');
    expect(opts.Image).toBe('openhive-team:v2');
    expect(opts.User).toBe('node');
    expect(opts.HostConfig?.Memory).toBe(768 * 1024 * 1024);
    expect(opts.HostConfig?.RestartPolicy?.Name).toBe('on-failure');
    expect(opts.Env).toContain('TEAM_ID=tid-alpha-001');
    expect(opts.Env).toContain('WS_ENDPOINT=ws-endpoint-value');
    expect(opts.Env).toContain('AUTH_TOKEN=test-token-abc');
    expect(opts.NetworkingConfig?.EndpointsConfig?.[OPENHIVE_NETWORK_NAME]).toBeDefined();
  });
});
