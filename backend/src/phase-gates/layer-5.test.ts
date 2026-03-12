/**
 * Layer 5 Phase Gate: Container integration tests.
 *
 * Tests ContainerProvisioner workspace scaffolding, ContainerRuntime security
 * enforcement (mock dockerode), ContainerRuntime lifecycle, ContainerManager
 * spawn/stop flows, HealthMonitor state machine and stuck agent detection,
 * and full integration wiring across all L5 components.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as yamlParse } from 'yaml';

import type {
  ContainerConfig,
  ContainerInfo,
  ContainerRuntime,
  BusEvent,
} from '../domain/index.js';
import { ContainerHealth, AgentStatus, ValidationError } from '../domain/index.js';

import { ContainerProvisionerImpl } from '../containers/provisioner.js';
import { ContainerRuntimeImpl, sanitizeInput, validateMountPath } from '../containers/runtime.js';
import { ContainerManagerImpl } from '../containers/manager.js';
import { HealthMonitorImpl } from '../containers/health.js';
import { TokenManagerImpl } from '../websocket/token-manager.js';
import { EventBusImpl } from '../control-plane/event-bus.js';

// ---------------------------------------------------------------------------
// Test helpers: temp directory management
// ---------------------------------------------------------------------------

let tmpRoot: string;

function createTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-l5-'));
}

// ---------------------------------------------------------------------------
// Test helpers: mock dockerode container
// ---------------------------------------------------------------------------

function createMockDockerodeContainer(
  id: string,
  slug: string,
  tid: string,
  state = 'running',
): {
  id: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
} {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: id,
      Name: `/openhive-${slug}`,
      State: { Status: state },
      Config: {
        Labels: {
          'openhive.managed': 'true',
          'openhive.team': slug,
          'openhive.tid': tid,
        },
      },
      Created: new Date().toISOString(),
    }),
  };
}

/** Creates a minimal mock Dockerode instance. */
function createMockDockerode(containers: Map<string, ReturnType<typeof createMockDockerodeContainer>>) {
  return {
    createContainer: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
      const name = opts.name as string;
      // Extract slug from "openhive-<slug>"
      const slug = name.replace(/^openhive-/, '');
      const tid = (opts.Labels as Record<string, string>)?.['openhive.tid'] ?? '';
      const id = `sha256-${slug}-${Date.now()}`;
      const container = createMockDockerodeContainer(id, slug, tid);
      containers.set(id, container);
      return container;
    }),
    getContainer: vi.fn().mockImplementation((id: string) => {
      const container = containers.get(id);
      if (!container) {
        throw new Error(`Container not found: ${id}`);
      }
      return container;
    }),
    listContainers: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Test helpers: mock ContainerRuntime
// ---------------------------------------------------------------------------

function createMockRuntime(): ContainerRuntime & {
  createContainer: ReturnType<typeof vi.fn>;
  startContainer: ReturnType<typeof vi.fn>;
  stopContainer: ReturnType<typeof vi.fn>;
  removeContainer: ReturnType<typeof vi.fn>;
  inspectContainer: ReturnType<typeof vi.fn>;
  listContainers: ReturnType<typeof vi.fn>;
} {
  let idCounter = 0;
  return {
    createContainer: vi.fn().mockImplementation(async (config: ContainerConfig) => {
      idCounter++;
      return `container-${config.teamSlug}-${idCounter}`;
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    inspectContainer: vi.fn().mockImplementation(async (id: string) => {
      const slug = id.replace(/^container-/, '').replace(/-\d+$/, '');
      return {
        id,
        name: `openhive-${slug}`,
        state: 'running',
        teamSlug: slug,
        tid: `tid-${slug}-000000`,
        health: ContainerHealth.Running,
        createdAt: Date.now(),
      } satisfies ContainerInfo;
    }),
    listContainers: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// 1. Provisioner scaffold + verify
// ---------------------------------------------------------------------------

describe('Layer 5: Containers', () => {
  beforeEach(() => {
    tmpRoot = createTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('Provisioner scaffold + verify', () => {
    it('should scaffold workspace with all required directories', async () => {
      const provisioner = new ContainerProvisionerImpl(tmpRoot);
      const workspacePath = await provisioner.scaffoldWorkspace(tmpRoot, 'weather-team');

      // Verify all expected directories exist
      const expectedDirs = [
        '.claude/agents',
        '.claude/skills',
        'memory',
        'work/tasks',
        'integrations',
        'plugins/sinks',
        'teams',
      ];

      for (const dir of expectedDirs) {
        const fullPath = path.join(workspacePath, dir);
        const stat = fs.statSync(fullPath);
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it('should create default team.yaml with correct slug', async () => {
      const provisioner = new ContainerProvisionerImpl(tmpRoot);
      const workspacePath = await provisioner.scaffoldWorkspace(tmpRoot, 'weather-team');

      const teamYaml = fs.readFileSync(path.join(workspacePath, 'team.yaml'), 'utf-8');
      const parsed = yamlParse(teamYaml) as Record<string, unknown>;
      expect(parsed.slug).toBe('weather-team');
      expect(parsed.agents).toEqual([]);
    });

    it('should write team config and read it back', async () => {
      const provisioner = new ContainerProvisionerImpl(tmpRoot);
      const workspacePath = await provisioner.scaffoldWorkspace(tmpRoot, 'code-team');

      const team = {
        tid: 'tid-code-team-abc123',
        slug: 'code-team',
        leader_aid: 'aid-lead-abc123',
        parent_tid: 'tid-root-000000',
        depth: 1,
        container_id: '',
        health: 'starting',
        agent_aids: ['aid-member1-abc123'],
        workspace_path: workspacePath,
        created_at: Date.now(),
      };

      await provisioner.writeTeamConfig(workspacePath, team);

      const readBack = fs.readFileSync(path.join(workspacePath, 'team.yaml'), 'utf-8');
      const parsed = yamlParse(readBack) as Record<string, unknown>;
      expect(parsed.slug).toBe('code-team');
      expect(parsed.tid).toBe('tid-code-team-abc123');
      expect(parsed.leader_aid).toBe('aid-lead-abc123');
    });

    it('should create default CLAUDE.md and settings.json', async () => {
      const provisioner = new ContainerProvisionerImpl(tmpRoot);
      const workspacePath = await provisioner.scaffoldWorkspace(tmpRoot, 'doc-team');

      const claudeMd = fs.readFileSync(path.join(workspacePath, '.claude/CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('doc-team');

      const settings = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.claude/settings.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(settings).toHaveProperty('allowedTools');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Runtime security (mock dockerode)
  // ---------------------------------------------------------------------------

  describe('Runtime security', () => {
    it('should create container with correct security settings (CapDrop, labels)', async () => {
      const containers = new Map<string, ReturnType<typeof createMockDockerodeContainer>>();
      const docker = createMockDockerode(containers);
      const runtime = new ContainerRuntimeImpl(docker as never);

      const config: ContainerConfig = {
        teamSlug: 'secure-team',
        tid: 'tid-secure-team-aaa111',
        image: 'openhive',
        workspacePath: '/app/workspace/teams/secure-team',
        env: { OPENHIVE_WS_TOKEN: 'abc123def456', OPENHIVE_TEAM_TID: 'tid-secure-team-aaa111' },
        networkMode: 'openhive-network',
      };

      await runtime.createContainer(config);

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      const callArgs = docker.createContainer.mock.calls[0][0] as Record<string, unknown>;

      // Verify security settings
      const hostConfig = callArgs.HostConfig as Record<string, unknown>;
      expect(hostConfig.CapDrop).toEqual(['ALL']);
      expect(hostConfig.Privileged).toBe(false);
      expect(hostConfig.ReadonlyRootfs).toBe(true);

      // Verify labels
      const labels = callArgs.Labels as Record<string, string>;
      expect(labels['openhive.managed']).toBe('true');
      expect(labels['openhive.team']).toBe('secure-team');
      expect(labels['openhive.tid']).toBe('tid-secure-team-aaa111');
    });

    it('should reject non-allowlisted image', async () => {
      const containers = new Map<string, ReturnType<typeof createMockDockerodeContainer>>();
      const docker = createMockDockerode(containers);
      const runtime = new ContainerRuntimeImpl(docker as never);

      const config: ContainerConfig = {
        teamSlug: 'evil-team',
        tid: 'tid-evil-team-bbb222',
        image: 'malicious-image',
        workspacePath: '/app/workspace/teams/evil-team',
        env: {},
        networkMode: 'openhive-network',
      };

      await expect(runtime.createContainer(config)).rejects.toThrow(ValidationError);
      await expect(runtime.createContainer(config)).rejects.toThrow(/not in the allowlist/);
    });

    it('should reject path traversal in mount path', () => {
      expect(() => validateMountPath('/app/workspace/../etc/passwd', '/app/workspace')).toThrow(
        ValidationError,
      );
    });

    it('should reject shell metacharacters in inputs', () => {
      expect(() => sanitizeInput('test;rm -rf /', 'name')).toThrow(ValidationError);
      expect(() => sanitizeInput('test|cat /etc/passwd', 'name')).toThrow(ValidationError);
      expect(() => sanitizeInput('test\x00null', 'name')).toThrow(ValidationError);
    });

    it('should reject host networking', async () => {
      const containers = new Map<string, ReturnType<typeof createMockDockerodeContainer>>();
      const docker = createMockDockerode(containers);
      const runtime = new ContainerRuntimeImpl(docker as never);

      const config: ContainerConfig = {
        teamSlug: 'host-team',
        tid: 'tid-host-team-ccc333',
        image: 'openhive',
        workspacePath: '/app/workspace/teams/host-team',
        env: {},
        networkMode: 'host',
      };

      await expect(runtime.createContainer(config)).rejects.toThrow(ValidationError);
      await expect(runtime.createContainer(config)).rejects.toThrow(/Host networking is not allowed/);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Runtime lifecycle (mock dockerode)
  // ---------------------------------------------------------------------------

  describe('Runtime lifecycle', () => {
    it('should create -> start -> inspect -> stop -> remove in correct order', async () => {
      const containers = new Map<string, ReturnType<typeof createMockDockerodeContainer>>();
      const docker = createMockDockerode(containers);
      const runtime = new ContainerRuntimeImpl(docker as never);

      // Create
      const config: ContainerConfig = {
        teamSlug: 'lifecycle-team',
        tid: 'tid-lifecycle-team-ddd444',
        image: 'openhive',
        workspacePath: '/app/workspace/teams/lifecycle-team',
        env: { OPENHIVE_WS_TOKEN: 'token123', OPENHIVE_TEAM_TID: 'tid-lifecycle-team-ddd444' },
        networkMode: 'openhive-network',
      };

      const containerId = await runtime.createContainer(config);
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      // Start
      await runtime.startContainer(containerId);
      const container = containers.get(containerId)!;
      expect(container.start).toHaveBeenCalledTimes(1);

      // Inspect
      const info = await runtime.inspectContainer(containerId);
      expect(info.id).toBe(containerId);
      expect(info.teamSlug).toBe('lifecycle-team');
      expect(info.tid).toBe('tid-lifecycle-team-ddd444');
      expect(container.inspect).toHaveBeenCalledTimes(1);

      // Stop (10s timeout -> 10 seconds passed to docker stop)
      await runtime.stopContainer(containerId, 10_000);
      expect(container.stop).toHaveBeenCalledWith({ t: 10 });

      // Remove
      await runtime.removeContainer(containerId);
      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Manager spawn flow (mock runtime + token manager + EventBus)
  // ---------------------------------------------------------------------------

  describe('Manager spawn flow', () => {
    it('should generate token, create container, and publish spawned event', async () => {
      const runtime = createMockRuntime();
      const tokenManager = new TokenManagerImpl();
      const eventBus = new EventBusImpl();

      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const manager = new ContainerManagerImpl(runtime, tokenManager, eventBus);

      const info = await manager.spawnTeamContainer('analytics-team');

      // Token was generated (tokenManager.generate was called internally)
      // Container was created with env vars
      expect(runtime.createContainer).toHaveBeenCalledTimes(1);
      const createArgs = runtime.createContainer.mock.calls[0][0] as ContainerConfig;
      expect(createArgs.env).toHaveProperty('OPENHIVE_WS_TOKEN');
      expect(createArgs.env).toHaveProperty('OPENHIVE_TEAM_TID');
      expect(createArgs.env.OPENHIVE_TEAM_TID).toMatch(/^tid-analytics-team-/);

      // Container was started
      expect(runtime.startContainer).toHaveBeenCalledTimes(1);

      // Inspect was called
      expect(runtime.inspectContainer).toHaveBeenCalledTimes(1);

      // Container info returned
      expect(info).toBeDefined();
      expect(info.state).toBe('running');

      // Event published (flush microtasks)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const spawnedEvent = events.find((e) => e.type === 'container.spawned');
      expect(spawnedEvent).toBeDefined();
      expect(spawnedEvent!.data.slug).toBe('analytics-team');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Manager stop flow
  // ---------------------------------------------------------------------------

  describe('Manager stop flow', () => {
    it('should stop container, remove it, and publish stopped event', async () => {
      const runtime = createMockRuntime();
      const tokenManager = new TokenManagerImpl();
      const eventBus = new EventBusImpl();

      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const manager = new ContainerManagerImpl(runtime, tokenManager, eventBus);

      // First spawn the container
      await manager.spawnTeamContainer('ephemeral-team');

      // Now stop it
      await manager.stopTeamContainer('ephemeral-team', 'test cleanup');

      // Runtime methods called
      expect(runtime.stopContainer).toHaveBeenCalledTimes(1);
      expect(runtime.removeContainer).toHaveBeenCalledTimes(1);

      // Container removed from internal tracking
      const containerInfo = await manager.getContainerByTeam('ephemeral-team');
      expect(containerInfo).toBeUndefined();

      // Event published
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const stoppedEvent = events.find((e) => e.type === 'container.stopped');
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent!.data.slug).toBe('ephemeral-team');
      expect(stoppedEvent!.data.reason).toBe('test cleanup');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. HealthMonitor state machine (fake timers)
  // ---------------------------------------------------------------------------

  describe('HealthMonitor state machine', () => {
    let healthMonitor: HealthMonitorImpl;
    let eventBus: EventBusImpl;

    beforeEach(() => {
      vi.useFakeTimers();
      eventBus = new EventBusImpl();
      healthMonitor = new HealthMonitorImpl(eventBus);
    });

    afterEach(() => {
      healthMonitor.stop();
      eventBus.close();
      vi.useRealTimers();
    });

    it('should transition through health states based on elapsed time', () => {
      const tid = 'tid-health-test-eee555';

      // Record initial heartbeat -> running
      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-agent1-abc123', status: AgentStatus.Idle, detail: '' },
      ]);
      expect(healthMonitor.getHealth(tid)).toBe(ContainerHealth.Running);

      // Advance 35s -> degraded (threshold is 30s)
      vi.advanceTimersByTime(35_000);
      expect(healthMonitor.getHealth(tid)).toBe(ContainerHealth.Degraded);

      // Advance to 65s total -> unhealthy (threshold is 60s)
      vi.advanceTimersByTime(30_000);
      expect(healthMonitor.getHealth(tid)).toBe(ContainerHealth.Unhealthy);

      // Advance to 95s total -> unreachable (threshold is 90s)
      vi.advanceTimersByTime(30_000);
      expect(healthMonitor.getHealth(tid)).toBe(ContainerHealth.Unreachable);

      // Record heartbeat -> back to running
      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-agent1-abc123', status: AgentStatus.Idle, detail: '' },
      ]);
      expect(healthMonitor.getHealth(tid)).toBe(ContainerHealth.Running);
    });

    it('should report starting for unknown containers', () => {
      expect(healthMonitor.getHealth('tid-unknown-fff666')).toBe(ContainerHealth.Starting);
    });

    it('should publish recovery event when heartbeat arrives after degraded state', async () => {
      const tid = 'tid-recover-ggg777';
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      // Initial heartbeat -> running (store the state)
      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-agent1-abc123', status: AgentStatus.Idle, detail: '' },
      ]);

      // Start the periodic check so checkTimeouts updates stored state
      healthMonitor.start();

      // Advance 35s so getHealth returns degraded
      vi.advanceTimersByTime(35_000);

      // The periodic check should fire and update stored state to degraded
      // Flush microtasks to process EventBus publish
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      // Now record a heartbeat — monitor detects recovery from degraded
      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-agent1-abc123', status: AgentStatus.Idle, detail: '' },
      ]);

      // Flush microtasks for event delivery
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      const recoveryEvent = events.find((e) => e.type === 'health.recovered');
      expect(recoveryEvent).toBeDefined();
      expect(recoveryEvent!.data.tid).toBe(tid);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. HealthMonitor stuck agent detection
  // ---------------------------------------------------------------------------

  describe('HealthMonitor stuck agent detection', () => {
    let healthMonitor: HealthMonitorImpl;
    let eventBus: EventBusImpl;

    beforeEach(() => {
      vi.useFakeTimers();
      eventBus = new EventBusImpl();
      healthMonitor = new HealthMonitorImpl(eventBus);
    });

    afterEach(() => {
      healthMonitor.stop();
      eventBus.close();
      vi.useRealTimers();
    });

    it('should detect stuck agents after timeout', () => {
      const tid = 'tid-stuck-test-hhh888';
      const stuckAid = 'aid-stuckagent-abc123';

      // Report agent as busy
      healthMonitor.recordHeartbeat(tid, [
        { aid: stuckAid, status: AgentStatus.Busy, detail: 'processing task' },
      ]);

      // Verify not stuck yet
      const thirtyMinMs = 30 * 60 * 1000;
      expect(healthMonitor.getStuckAgents(thirtyMinMs)).toHaveLength(0);

      // Advance past 30 minutes — heartbeats still report the same busy status
      vi.advanceTimersByTime(thirtyMinMs + 1000);

      // Must send another heartbeat to keep the container alive, but agent stays busy
      healthMonitor.recordHeartbeat(tid, [
        { aid: stuckAid, status: AgentStatus.Busy, detail: 'still processing' },
      ]);

      // The agent was first reported as busy at original time.
      // After advancing 30min+1s, the statusSince stayed at the original time
      // because the status (Busy) didn't change between heartbeats.
      expect(healthMonitor.getStuckAgents(thirtyMinMs)).toContain(stuckAid);
    });

    it('should not flag idle agents as stuck', () => {
      const tid = 'tid-idle-test-iii999';

      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-idleagent-abc123', status: AgentStatus.Idle, detail: '' },
      ]);

      vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-idleagent-abc123', status: AgentStatus.Idle, detail: '' },
      ]);

      expect(healthMonitor.getStuckAgents(30 * 60 * 1000)).toHaveLength(0);
    });

    it('should clear stuck status when agent becomes idle', () => {
      const tid = 'tid-clear-test-jjj000';
      const aid = 'aid-clearagent-abc123';
      const thirtyMinMs = 30 * 60 * 1000;

      // Start busy
      healthMonitor.recordHeartbeat(tid, [
        { aid, status: AgentStatus.Busy, detail: 'working' },
      ]);

      vi.advanceTimersByTime(thirtyMinMs + 1000);

      // Still busy in next heartbeat
      healthMonitor.recordHeartbeat(tid, [
        { aid, status: AgentStatus.Busy, detail: 'still working' },
      ]);
      expect(healthMonitor.getStuckAgents(thirtyMinMs)).toContain(aid);

      // Agent becomes idle — statusSince resets
      healthMonitor.recordHeartbeat(tid, [
        { aid, status: AgentStatus.Idle, detail: 'done' },
      ]);
      expect(healthMonitor.getStuckAgents(thirtyMinMs)).not.toContain(aid);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Integration wiring
  // ---------------------------------------------------------------------------

  describe('Integration wiring (Manager + Provisioner + Runtime + HealthMonitor + TokenManager + EventBus)', () => {
    it('should spawn team, receive heartbeat, verify health, stop team, and verify cleanup', async () => {
      vi.useFakeTimers();

      const runtime = createMockRuntime();
      const tokenManager = new TokenManagerImpl();
      const eventBus = new EventBusImpl();
      const healthMonitor = new HealthMonitorImpl(eventBus);

      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const manager = new ContainerManagerImpl(runtime, tokenManager, eventBus);

      // Step 1: Spawn a team container
      const info = await manager.spawnTeamContainer('integration-team');
      expect(info).toBeDefined();
      expect(info.state).toBe('running');

      // Flush microtasks for event delivery
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(events.some((e) => e.type === 'container.spawned')).toBe(true);

      // Step 2: Simulate heartbeat arriving from the container
      const tid = (runtime.createContainer.mock.calls[0][0] as ContainerConfig).tid;
      healthMonitor.recordHeartbeat(tid, [
        { aid: 'aid-member1-abc123', status: AgentStatus.Idle, detail: 'ready' },
      ]);

      // Step 3: Health should be running
      expect(healthMonitor.getHealth(tid)).toBe(ContainerHealth.Running);

      // Step 4: Stop the team container
      await manager.stopTeamContainer('integration-team', 'test complete');

      // Verify runtime was called correctly
      expect(runtime.stopContainer).toHaveBeenCalledTimes(1);
      expect(runtime.removeContainer).toHaveBeenCalledTimes(1);

      // Verify container removed from manager tracking
      const afterStop = await manager.getContainerByTeam('integration-team');
      expect(afterStop).toBeUndefined();

      // Flush microtasks for stop event
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(events.some((e) => e.type === 'container.stopped')).toBe(true);

      // Step 5: Verify agent health is still queryable from the monitor
      // (the health monitor is independent of the container manager)
      expect(healthMonitor.getAgentHealth('aid-member1-abc123')).toBe(AgentStatus.Idle);

      healthMonitor.stop();
      eventBus.close();
      vi.useRealTimers();
    });
  });
});
