/**
 * Container manager — high-level container lifecycle coordination.
 *
 * Provides the {@link ContainerManager} interface that coordinates the full
 * lifecycle of team containers: spawning, stopping, restarting, querying,
 * and cleanup. This is the primary entry point for all container operations
 * from the orchestrator.
 *
 * // INV-05: Root spawns all containers
 * This module runs exclusively in the root container (`OPENHIVE_IS_ROOT=true`).
 * Non-root containers MUST NOT instantiate or call ContainerManagerImpl.
 *
 * @module containers/manager
 */

import type {
  ContainerManager,
  ContainerRuntime,
  ContainerConfig,
  ContainerInfo,
  TokenManager,
  EventBus,
  ContainerProvisioner,
} from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';

// INV-05: Root spawns all containers

/** Default graceful shutdown timeout in milliseconds (30 seconds). */
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/** Internal tracking entry for a managed container. */
interface ContainerEntry {
  containerId: string;
  slug: string;
  tid: string;
  status: string;
}

/** Configuration for container spawning. */
export interface ContainerManagerConfig {
  /** Docker image name (default: 'openhive'). */
  image?: string;
  /** Docker network name (default: 'openhive-network'). */
  network?: string;
  /** Base workspace path on the host (default: '/app/workspace'). */
  workspaceRoot?: string;
  /** Root container host address for WS connections (default: 'root'). */
  rootHost?: string;
  /** Memory limit string (e.g., '512m'). */
  memoryLimit?: string;
  /** CPU quota (Docker CpuQuota). */
  cpuLimit?: number;
}

/**
 * High-level container lifecycle manager.
 *
 * Implements the {@link ContainerManager} interface, coordinating container
 * creation, shutdown, restart, querying, and cleanup. Delegates low-level
 * Docker operations to {@link ContainerRuntime}.
 */
export class ContainerManagerImpl implements ContainerManager {
  private readonly runtime: ContainerRuntime;
  private readonly tokenManager: TokenManager;
  private readonly eventBus: EventBus;
  // Provisioner stored for future workspace resolution (L6+)
  readonly provisioner: ContainerProvisioner | undefined;
  private readonly config: Required<ContainerManagerConfig>;

  /** Slug -> container entry mapping for fast lookup. */
  private readonly containers = new Map<string, ContainerEntry>();

  /** Prevents infinite recursion in bidirectional lead/team cascade. */
  private readonly deletionGuard = new Set<string>();

  constructor(
    runtime: ContainerRuntime,
    tokenManager: TokenManager,
    eventBus: EventBus,
    provisioner?: ContainerProvisioner,
    config?: ContainerManagerConfig,
  ) {
    this.runtime = runtime;
    this.tokenManager = tokenManager;
    this.eventBus = eventBus;
    this.provisioner = provisioner;
    this.config = {
      image: config?.image ?? 'openhive',
      network: config?.network ?? 'openhive-network',
      workspaceRoot: config?.workspaceRoot ?? '/app/workspace',
      rootHost: config?.rootHost ?? 'root',
      memoryLimit: config?.memoryLimit ?? '512m',
      cpuLimit: config?.cpuLimit ?? 50_000,
    };
  }

  async spawnTeamContainer(teamSlug: string): Promise<ContainerInfo> {
    // INV-05: Root spawns all containers

    // Reject duplicate — at most one container per slug
    const existing = this.containers.get(teamSlug);
    if (existing) {
      throw new ConflictError(
        `Container already exists for team "${teamSlug}" (id: ${existing.containerId}). Stop it first.`,
      );
    }

    // Generate TID for container identification
    const tid = `tid-${teamSlug}-${randomHex(6)}`;

    // Resolve workspace path
    const workspacePath = `${this.config.workspaceRoot}/teams/${teamSlug}`;

    // Generate one-time WS auth token bound to this TID
    const wsToken = this.tokenManager.generate(tid);

    // Assemble container config
    const containerConfig: ContainerConfig = {
      teamSlug,
      tid,
      image: this.config.image,
      workspacePath,
      env: {
        OPENHIVE_WS_TOKEN: wsToken,
        OPENHIVE_TEAM_TID: tid,
        OPENHIVE_ROOT_HOST: this.config.rootHost,
      },
      networkMode: this.config.network,
      memoryLimit: this.config.memoryLimit,
      cpuLimit: this.config.cpuLimit,
    };

    // Create and start the container via runtime
    const containerId = await this.runtime.createContainer(containerConfig);
    await this.runtime.startContainer(containerId);

    // Register in internal map
    const entry: ContainerEntry = {
      containerId,
      slug: teamSlug,
      tid,
      status: 'running',
    };
    this.containers.set(teamSlug, entry);

    // Publish lifecycle event
    this.eventBus.publish({
      type: 'container.spawned',
      data: { slug: teamSlug, containerId, tid },
      timestamp: Date.now(),
      source: 'container-manager',
    });

    // Inspect to return full ContainerInfo
    return this.runtime.inspectContainer(containerId);
  }

  async stopTeamContainer(teamSlug: string, reason: string): Promise<void> {
    // Deletion guard: break recursion in bidirectional cascade
    if (this.deletionGuard.has(teamSlug)) {
      return;
    }
    this.deletionGuard.add(teamSlug);

    try {
      const entry = this.containers.get(teamSlug);
      if (!entry) {
        throw new NotFoundError(`No container found for team "${teamSlug}"`);
      }

      // Graceful stop with timeout, then remove
      await this.runtime.stopContainer(entry.containerId, DEFAULT_STOP_TIMEOUT_MS);
      await this.runtime.removeContainer(entry.containerId);

      // Unregister from internal map
      this.containers.delete(teamSlug);

      // Publish lifecycle event
      this.eventBus.publish({
        type: 'container.stopped',
        data: { slug: teamSlug, containerId: entry.containerId, tid: entry.tid, reason },
        timestamp: Date.now(),
        source: 'container-manager',
      });
    } finally {
      this.deletionGuard.delete(teamSlug);
    }
  }

  async restartTeamContainer(teamSlug: string, reason: string): Promise<void> {
    await this.stopTeamContainer(teamSlug, reason);
    await this.spawnTeamContainer(teamSlug);
  }

  async getContainerByTeam(teamSlug: string): Promise<ContainerInfo | undefined> {
    const entry = this.containers.get(teamSlug);
    if (!entry) {
      return undefined;
    }
    return this.runtime.inspectContainer(entry.containerId);
  }

  async listRunningContainers(): Promise<ContainerInfo[]> {
    return this.runtime.listContainers();
  }

  async cleanupStoppedContainers(): Promise<number> {
    const allContainers = await this.runtime.listContainers();
    let removed = 0;

    for (const container of allContainers) {
      if (container.state !== 'running') {
        await this.runtime.removeContainer(container.id);
        // Clean up internal map if we have an entry for this slug
        if (container.teamSlug && this.containers.has(container.teamSlug)) {
          this.containers.delete(container.teamSlug);
        }
        removed++;
      }
    }

    return removed;
  }
}

/** Generates a short hex string for IDs. */
function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}
