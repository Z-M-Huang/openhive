/**
 * Tests for ContainerRuntimeImpl.
 *
 * Mocks dockerode to verify security constraints (AC26), lifecycle operations,
 * and correct mapping of Docker API responses to domain types.
 *
 * @module containers/runtime.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContainerRuntimeImpl, sanitizeInput, validateMountPath } from './runtime.js';
import { ValidationError } from '../domain/errors.js';
import { ContainerHealth } from '../domain/enums.js';
import type { ContainerConfig } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Mock dockerode
// ---------------------------------------------------------------------------

function createMockContainer(overrides?: Record<string, unknown>) {
  return {
    id: 'abc123def456',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: 'abc123def456',
      Created: '2026-03-12T00:00:00.000Z',
      Name: '/openhive-test-team',
      State: { Status: 'running', Running: true },
      Config: {
        Labels: {
          'openhive.managed': 'true',
          'openhive.team': 'test-team',
          'openhive.tid': 'tid-test-abc123',
        },
      },
    }),
    ...overrides,
  };
}

function createMockDocker(containerMock?: ReturnType<typeof createMockContainer>) {
  const mockContainer = containerMock ?? createMockContainer();
  return {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    _mockContainer: mockContainer,
  };
}

/** Builds a valid ContainerConfig for testing. */
function validConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    teamSlug: 'test-team',
    tid: 'tid-test-abc123',
    image: 'openhive',
    workspacePath: '/app/workspace/teams/test-team',
    env: { OPENHIVE_IS_ROOT: 'false' },
    networkMode: 'openhive-network',
    memoryLimit: '512m',
    cpuLimit: 50000,
    ...overrides,
  };
}

describe('ContainerRuntimeImpl', () => {
  let mockDocker: ReturnType<typeof createMockDocker>;
  let runtime: ContainerRuntimeImpl;

  beforeEach(() => {
    mockDocker = createMockDocker();
    // Cast mock to Dockerode — tests only call the methods we mock
    runtime = new ContainerRuntimeImpl(mockDocker as never);
  });

  // -------------------------------------------------------------------------
  // Security: Input sanitization
  // -------------------------------------------------------------------------

  describe('sanitizeInput', () => {
    it('allows clean alphanumeric strings', () => {
      expect(() => sanitizeInput('hello-world-123', 'field')).not.toThrow();
    });

    it('rejects semicolons', () => {
      expect(() => sanitizeInput('hello;world', 'field')).toThrow(ValidationError);
    });

    it('rejects pipe characters', () => {
      expect(() => sanitizeInput('hello|world', 'field')).toThrow(ValidationError);
    });

    it('rejects ampersand', () => {
      expect(() => sanitizeInput('hello&world', 'field')).toThrow(ValidationError);
    });

    it('rejects dollar sign', () => {
      expect(() => sanitizeInput('hello$world', 'field')).toThrow(ValidationError);
    });

    it('rejects backtick', () => {
      expect(() => sanitizeInput('hello`world', 'field')).toThrow(ValidationError);
    });

    it('rejects newlines', () => {
      expect(() => sanitizeInput('hello\nworld', 'field')).toThrow(ValidationError);
    });

    it('rejects null bytes', () => {
      expect(() => sanitizeInput('hello\0world', 'field')).toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // Security: Mount path validation
  // -------------------------------------------------------------------------

  describe('validateMountPath', () => {
    it('accepts path within workspace root', () => {
      expect(() => validateMountPath('/app/workspace/teams/foo', '/app/workspace')).not.toThrow();
    });

    it('accepts the workspace root itself', () => {
      expect(() => validateMountPath('/app/workspace', '/app/workspace')).not.toThrow();
    });

    it('rejects path traversal with ..', () => {
      expect(() =>
        validateMountPath('/app/workspace/../../etc/passwd', '/app/workspace'),
      ).toThrow(ValidationError);
    });

    it('rejects path completely outside workspace', () => {
      expect(() => validateMountPath('/etc/passwd', '/app/workspace')).toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // Security: Image allowlist
  // -------------------------------------------------------------------------

  describe('createContainer — image allowlist', () => {
    it('rejects non-allowlisted image', async () => {
      const config = validConfig({ image: 'alpine' });
      await expect(runtime.createContainer(config)).rejects.toThrow(ValidationError);
      await expect(runtime.createContainer(config)).rejects.toThrow(/not in the allowlist/);
    });

    it('accepts the openhive image', async () => {
      const config = validConfig();
      await runtime.createContainer(config);
      expect(mockDocker.createContainer).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Security: Host networking rejection
  // -------------------------------------------------------------------------

  describe('createContainer — network mode', () => {
    it('rejects host networking', async () => {
      const config = validConfig({ networkMode: 'host' });
      await expect(runtime.createContainer(config)).rejects.toThrow(ValidationError);
      await expect(runtime.createContainer(config)).rejects.toThrow(/Host networking/);
    });
  });

  // -------------------------------------------------------------------------
  // Security: CapDrop ALL
  // -------------------------------------------------------------------------

  describe('createContainer — capabilities', () => {
    it('sets CapDrop to ALL', async () => {
      const config = validConfig();
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.CapDrop).toEqual(['ALL']);
    });

    it('sets Privileged to false', async () => {
      const config = validConfig();
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.Privileged).toBe(false);
    });

    it('sets ReadonlyRootfs to true', async () => {
      const config = validConfig();
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.ReadonlyRootfs).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Security: Labels
  // -------------------------------------------------------------------------

  describe('createContainer — labels', () => {
    it('sets openhive.managed=true label', async () => {
      const config = validConfig();
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.Labels['openhive.managed']).toBe('true');
    });

    it('sets team and tid labels', async () => {
      const config = validConfig();
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.Labels['openhive.team']).toBe('test-team');
      expect(callArgs.Labels['openhive.tid']).toBe('tid-test-abc123');
    });
  });

  // -------------------------------------------------------------------------
  // Security: Shell metacharacters in container name
  // -------------------------------------------------------------------------

  describe('createContainer — input sanitization', () => {
    it('rejects shell metacharacters in teamSlug', async () => {
      // The slug validation will reject this before sanitizeInput gets to it,
      // but both should reject it
      const config = validConfig({ teamSlug: 'test;rm -rf /' });
      await expect(runtime.createContainer(config)).rejects.toThrow();
    });

    it('rejects shell metacharacters in env values', async () => {
      const config = validConfig({ env: { KEY: 'value;malicious' } });
      await expect(runtime.createContainer(config)).rejects.toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // Security: Resource limits
  // -------------------------------------------------------------------------

  describe('createContainer — resource limits', () => {
    it('sets memory limit from config', async () => {
      const config = validConfig({ memoryLimit: '1g' });
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    });

    it('sets CPU quota from config', async () => {
      const config = validConfig({ cpuLimit: 100000 });
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.CpuQuota).toBe(100000);
    });

    it('uses default memory if not specified', async () => {
      const config = validConfig();
      delete (config as unknown as Record<string, unknown>).memoryLimit;
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.Memory).toBe(512 * 1024 * 1024);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle: create + start + stop + remove
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('createContainer returns container ID', async () => {
      const config = validConfig();
      const id = await runtime.createContainer(config);
      expect(id).toBe('abc123def456');
    });

    it('startContainer calls docker start', async () => {
      await runtime.startContainer('abc123def456');
      expect(mockDocker._mockContainer.start).toHaveBeenCalled();
    });

    it('stopContainer calls docker stop with timeout in seconds', async () => {
      await runtime.stopContainer('abc123def456', 10000);
      expect(mockDocker._mockContainer.stop).toHaveBeenCalledWith({ t: 10 });
    });

    it('stopContainer falls back to kill on timeout error', async () => {
      const mockContainer = createMockContainer({
        stop: vi.fn().mockRejectedValue(new Error('container timeout')),
      });
      const docker = createMockDocker(mockContainer);
      const rt = new ContainerRuntimeImpl(docker as never);

      await rt.stopContainer('abc123def456', 5000);
      expect(mockContainer.kill).toHaveBeenCalled();
    });

    it('removeContainer calls docker remove with force', async () => {
      await runtime.removeContainer('abc123def456');
      expect(mockDocker._mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  // -------------------------------------------------------------------------
  // inspectContainer
  // -------------------------------------------------------------------------

  describe('inspectContainer', () => {
    it('maps Docker inspect response to ContainerInfo', async () => {
      const info = await runtime.inspectContainer('abc123def456');

      expect(info.id).toBe('abc123def456');
      expect(info.name).toBe('openhive-test-team');
      expect(info.state).toBe('running');
      expect(info.teamSlug).toBe('test-team');
      expect(info.tid).toBe('tid-test-abc123');
      expect(info.health).toBe(ContainerHealth.Running);
      expect(info.createdAt).toBe(new Date('2026-03-12T00:00:00.000Z').getTime());
    });
  });

  // -------------------------------------------------------------------------
  // listContainers
  // -------------------------------------------------------------------------

  describe('listContainers', () => {
    it('filters by openhive.managed label', async () => {
      await runtime.listContainers();

      expect(mockDocker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['openhive.managed=true'] },
      });
    });

    it('maps Docker list response to ContainerInfo array', async () => {
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'container1',
          Names: ['/openhive-team-a'],
          State: 'running',
          Created: 1710201600, // seconds
          Labels: {
            'openhive.managed': 'true',
            'openhive.team': 'team-a',
            'openhive.tid': 'tid-team-abc',
          },
        },
        {
          Id: 'container2',
          Names: ['/openhive-team-b'],
          State: 'exited',
          Created: 1710201500,
          Labels: {
            'openhive.managed': 'true',
            'openhive.team': 'team-b',
            'openhive.tid': 'tid-team-def',
          },
        },
      ]);

      const list = await runtime.listContainers();

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('container1');
      expect(list[0].name).toBe('openhive-team-a');
      expect(list[0].state).toBe('running');
      expect(list[0].health).toBe(ContainerHealth.Running);
      expect(list[0].createdAt).toBe(1710201600000);

      expect(list[1].id).toBe('container2');
      expect(list[1].health).toBe(ContainerHealth.Stopped);
    });
  });

  // -------------------------------------------------------------------------
  // Container name format
  // -------------------------------------------------------------------------

  describe('createContainer — naming', () => {
    it('prefixes container name with openhive-', async () => {
      const config = validConfig({ teamSlug: 'weather-team' });
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.name).toBe('openhive-weather-team');
    });
  });

  // -------------------------------------------------------------------------
  // Tmpfs mount
  // -------------------------------------------------------------------------

  describe('createContainer — tmpfs', () => {
    it('includes /tmp tmpfs mount with noexec,nosuid', async () => {
      const config = validConfig();
      await runtime.createContainer(config);

      const callArgs = mockDocker.createContainer.mock.calls[0][0];
      expect(callArgs.HostConfig.Tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid' });
    });
  });
});
