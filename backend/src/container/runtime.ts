/**
 * OpenHive Backend - Container Runtime
 *
 * Implements ContainerRuntime using the dockerode library. Manages Docker
 * container lifecycle for team containers:
 *   - createContainer: validates config, sanitizes env, sets memory limit,
 *     creates container with openhive-network attachment.
 *   - startContainer / stopContainer / removeContainer: thin wrappers around
 *     dockerode Container methods.
 *   - inspectContainer: maps Docker state to domain ContainerState.
 *   - listContainers: filters by "openhive-" name prefix.
 *   - ensureNetwork: idempotent network creation with ICC disabled.
 */

import Dockerode from 'dockerode';

import type { ContainerRuntime } from '../domain/interfaces.js';
import type { ContainerConfig, ContainerInfo } from '../domain/types.js';
import type { ContainerState } from '../domain/enums.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Docker network used by all OpenHive team containers. */
export const OPENHIVE_NETWORK_NAME = 'openhive-network';

/** Prefix added to every container name. */
export const CONTAINER_NAME_PREFIX = 'openhive-';

/** ICC (inter-container communication) bridge option name. */
const NETWORK_ICC_OPTION = 'com.docker.network.bridge.enable_icc';

/** Default memory limit: 512 MB. */
export const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024;

/** Non-root user that runs inside team containers (matches Dockerfile.team USER). */
const CONTAINER_USER = 'node';

/** POSIX environment variable name pattern. */
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface required by RuntimeImpl.
 * Compatible with pino or any standard structured logger.
 */
export interface RuntimeLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// DockerContainer — container handle interface
// ---------------------------------------------------------------------------

/**
 * Represents a container handle returned by DockerClient.
 * Provides methods to operate on a specific container by ID.
 *
 * This abstraction allows test doubles to be injected without a real
 * Docker daemon.
 */
export interface DockerContainer {
  /** The container's full ID as assigned by Docker. */
  readonly id: string;
  start(): Promise<void>;
  stop(opts?: { t?: number }): Promise<void>;
  remove(opts?: { force?: boolean }): Promise<void>;
  inspect(): Promise<Dockerode.ContainerInspectInfo>;
}

// ---------------------------------------------------------------------------
// DockerClient — abstraction over dockerode for testability
// ---------------------------------------------------------------------------

/**
 * Wraps the dockerode methods used by RuntimeImpl, enabling test doubles.
 *
 * Key design choices:
 *   - getContainer(id) returns a lazy container handle (no network call).
 *     This matches how dockerode works: docker.getContainer(id) is synchronous.
 *   - createContainer returns a DockerContainer (already has the ID).
 *   - listContainers / listNetworks / createNetwork are direct delegates.
 */
export interface DockerClient {
  /** Returns a lazy handle for an existing container. No network call. */
  getContainer(id: string): DockerContainer;
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<DockerContainer>;
  listContainers(options?: Dockerode.ContainerListOptions): Promise<Dockerode.ContainerInfo[]>;
  listNetworks(options?: Dockerode.NetworkListOptions): Promise<Dockerode.NetworkInspectInfo[]>;
  createNetwork(options: Dockerode.NetworkCreateOptions): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// DockerodeClient — wraps the real dockerode instance
// ---------------------------------------------------------------------------

/**
 * Thin adapter that wraps a real Dockerode instance into our DockerClient
 * interface.
 */
class DockerodeClient implements DockerClient {
  private readonly docker: Dockerode;

  constructor(docker: Dockerode) {
    this.docker = docker;
  }

  getContainer(id: string): DockerContainer {
    return new DockerodeContainerHandle(this.docker.getContainer(id));
  }

  async createContainer(options: Dockerode.ContainerCreateOptions): Promise<DockerContainer> {
    const container = await this.docker.createContainer(options);
    return new DockerodeContainerHandle(container);
  }

  async listContainers(options?: Dockerode.ContainerListOptions): Promise<Dockerode.ContainerInfo[]> {
    return this.docker.listContainers(options);
  }

  async listNetworks(options?: Dockerode.NetworkListOptions): Promise<Dockerode.NetworkInspectInfo[]> {
    return this.docker.listNetworks(options);
  }

  async createNetwork(options: Dockerode.NetworkCreateOptions): Promise<{ id: string }> {
    const network = await this.docker.createNetwork(options);
    const info = await network.inspect();
    return { id: info.Id };
  }
}

/**
 * Adapts a dockerode Container object to our DockerContainer interface.
 */
class DockerodeContainerHandle implements DockerContainer {
  private readonly container: Dockerode.Container;

  constructor(container: Dockerode.Container) {
    this.container = container;
  }

  get id(): string {
    return this.container.id;
  }

  async start(): Promise<void> {
    await this.container.start({});
  }

  async stop(opts?: { t?: number }): Promise<void> {
    await this.container.stop(opts);
  }

  async remove(opts?: { force?: boolean }): Promise<void> {
    await this.container.remove(opts);
  }

  async inspect(): Promise<Dockerode.ContainerInspectInfo> {
    return this.container.inspect();
  }
}

// ---------------------------------------------------------------------------
// RuntimeImpl — implements ContainerRuntime
// ---------------------------------------------------------------------------

/**
 * Implements domain.ContainerRuntime using dockerode.
 *
 *
 * Usage:
 *   const runtime = new RuntimeImpl(client, 'openhive-team', logger);
 *   await runtime.ensureNetwork();
 *   const id = await runtime.createContainer({ name: 'my-team', env: {...} });
 *   await runtime.startContainer(id);
 */
export class RuntimeImpl implements ContainerRuntime {
  private readonly client: DockerClient;
  private readonly defaultImageName: string;
  private readonly logger: RuntimeLogger;
  /** Cached network ID after ensureNetwork() completes. */
  private networkID: string = '';

  constructor(client: DockerClient, imageName: string, logger: RuntimeLogger) {
    this.client = client;
    this.defaultImageName = imageName;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // createContainer
  // -------------------------------------------------------------------------

  /**
   * Creates a new Docker container for a team.
   *
   *
   * - Validates the container name (required).
   * - Sanitizes env vars (rejects invalid keys; skips values with unsafe chars).
   * - Parses memory limit from human-readable format (512m, 1g).
   * - Attaches container to openhive-network.
   * - Runs as CONTAINER_USER (non-root).
   * - Sets on-failure restart policy.
   *
   * Returns the Docker container ID.
   */
  async createContainer(config: ContainerConfig): Promise<string> {
    if (config.name === undefined || config.name === '') {
      throw new ValidationError('name', 'container name is required');
    }

    const containerName = CONTAINER_NAME_PREFIX + config.name;
    const imageName = (config.image_name !== undefined && config.image_name !== '')
      ? config.image_name
      : this.defaultImageName;

    // Build sanitized environment list
    const envList = sanitizeEnvVars(config.env ?? {}, this.logger);

    // Parse memory limit
    let memLimit = DEFAULT_MEMORY_LIMIT;
    if (config.max_memory !== undefined && config.max_memory !== '') {
      const parsed = parseMemoryLimit(config.max_memory);
      if (parsed === null) {
        this.logger.warn('invalid max_memory in container config, using default', {
          value: config.max_memory,
        });
      } else {
        memLimit = parsed;
      }
    }

    // Use the cached network ID if ensureNetwork() has been called, else use name
    const networkMode = this.networkID !== '' ? this.networkID : OPENHIVE_NETWORK_NAME;

    const options: Dockerode.ContainerCreateOptions = {
      name: containerName,
      Image: imageName,
      Env: envList,
      User: CONTAINER_USER,
      HostConfig: {
        NetworkMode: networkMode,
        Memory: memLimit,
        Binds: config.binds,
        RestartPolicy: {
          Name: 'on-failure',
        },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [OPENHIVE_NETWORK_NAME]: {},
        },
      },
    };

    const container = await this.client.createContainer(options);

    this.logger.info('container created', {
      container_id: container.id,
      container_name: containerName,
      image: imageName,
    });

    return container.id;
  }

  // -------------------------------------------------------------------------
  // startContainer
  // -------------------------------------------------------------------------

  /**
   * Starts a previously created container.
   */
  async startContainer(containerID: string): Promise<void> {
    const container = this.client.getContainer(containerID);
    try {
      await container.start();
    } catch (err) {
      throw new Error(`start container "${containerID}": ${errorMessage(err)}`);
    }
    this.logger.info('container started', { container_id: containerID });
  }

  // -------------------------------------------------------------------------
  // stopContainer
  // -------------------------------------------------------------------------

  /**
   * Stops a running container, waiting up to timeoutMs for graceful shutdown.
   */
  async stopContainer(containerID: string, timeoutMs: number): Promise<void> {
    const container = this.client.getContainer(containerID);
    const timeoutSecs = Math.round(timeoutMs / 1000);
    try {
      await container.stop({ t: timeoutSecs });
    } catch (err) {
      throw new Error(`stop container "${containerID}": ${errorMessage(err)}`);
    }
    this.logger.info('container stopped', { container_id: containerID });
  }

  // -------------------------------------------------------------------------
  // removeContainer
  // -------------------------------------------------------------------------

  /**
   * Removes a container (force=true to bypass stopped requirement).
   */
  async removeContainer(containerID: string): Promise<void> {
    const container = this.client.getContainer(containerID);
    try {
      await container.remove({ force: true });
    } catch (err) {
      throw new Error(`remove container "${containerID}": ${errorMessage(err)}`);
    }
    this.logger.info('container removed', { container_id: containerID });
  }

  // -------------------------------------------------------------------------
  // inspectContainer
  // -------------------------------------------------------------------------

  /**
   * Returns the current state of a container, mapping Docker status strings
   * to domain.ContainerState.
   */
  async inspectContainer(containerID: string): Promise<ContainerInfo> {
    const container = this.client.getContainer(containerID);
    let info: Dockerode.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err) {
      throw new Error(`inspect container "${containerID}": ${errorMessage(err)}`);
    }

    const state = mapDockerState(info.State.Status);
    // Docker prepends "/" to container names in inspect output
    const name = info.Name.startsWith('/') ? info.Name.slice(1) : info.Name;

    return {
      id: info.Id,
      name,
      state,
    };
  }

  // -------------------------------------------------------------------------
  // listContainers
  // -------------------------------------------------------------------------

  /**
   * Returns all containers managed by OpenHive (name prefix filter).
   */
  async listContainers(): Promise<ContainerInfo[]> {
    let list: Dockerode.ContainerInfo[];
    try {
      list = await this.client.listContainers({
        all: true,
        filters: JSON.stringify({ name: [CONTAINER_NAME_PREFIX] }),
      });
    } catch (err) {
      throw new Error(`list containers: ${errorMessage(err)}`);
    }

    // Docker's name filter is a substring match, so "openhive-" also matches
    // unrelated containers (e.g. "deployments-openhive-1"). Post-filter to only
    // return containers whose names actually start with the prefix.
    return list
      .map((c) => {
        const state = mapDockerState(c.State);
        const name = (c.Names.length > 0)
          ? (c.Names[0].startsWith('/') ? c.Names[0].slice(1) : c.Names[0])
          : '';
        return {
          id: c.Id,
          name,
          state,
        };
      })
      .filter((c) => c.name.startsWith(CONTAINER_NAME_PREFIX));
  }

  // -------------------------------------------------------------------------
  // ensureNetwork
  // -------------------------------------------------------------------------

  /**
   * Creates the openhive-network if it does not already exist.
   * ICC (inter-container communication) is disabled on the bridge network.
   * Returns the network ID.
   */
  async ensureNetwork(): Promise<string> {
    let networks: Dockerode.NetworkInspectInfo[];
    try {
      networks = await this.client.listNetworks({
        filters: JSON.stringify({ name: [OPENHIVE_NETWORK_NAME] }),
      });
    } catch (err) {
      throw new Error(`list networks: ${errorMessage(err)}`);
    }

    for (const n of networks) {
      if (n.Name === OPENHIVE_NETWORK_NAME) {
        this.networkID = n.Id;
        this.logger.debug('openhive-network already exists', { network_id: n.Id });
        return n.Id;
      }
    }

    // Create the network with ICC disabled
    let created: { id: string };
    try {
      created = await this.client.createNetwork({
        Name: OPENHIVE_NETWORK_NAME,
        Driver: 'bridge',
        Options: {
          [NETWORK_ICC_OPTION]: 'false',
        },
      });
    } catch (err) {
      throw new Error(`create network "${OPENHIVE_NETWORK_NAME}": ${errorMessage(err)}`);
    }

    this.networkID = created.id;
    this.logger.info('openhive-network created', { network_id: created.id });
    return created.id;
  }
}

// ---------------------------------------------------------------------------
// mapDockerState — maps Docker status strings to domain ContainerState
// ---------------------------------------------------------------------------

/**
 * Converts a Docker container status string to domain.ContainerState.
 *
 * Docker status strings (from `docker ps`):
 *   created, running, restarting, paused, exited, dead, removing
 */
export function mapDockerState(status: string): ContainerState {
  switch (status) {
    case 'created':
      return 'created';
    case 'running':
      return 'running';
    case 'restarting':
      return 'starting';
    case 'paused':
    case 'exited':
    case 'dead':
      return 'stopped';
    case 'removing':
      return 'removing';
    default:
      return 'failed';
  }
}

// ---------------------------------------------------------------------------
// sanitizeEnvVars — validates and sanitizes environment variables
// ---------------------------------------------------------------------------

/**
 * Validates and sanitizes a map of environment variables.
 *
 * Rules:
 *   - Key names must match ^[A-Za-z_][A-Za-z0-9_]*$.
 *     Invalid keys cause a ValidationError to be thrown.
 *   - Values must not contain newline (\n, \r) or null (\x00) characters.
 *     Entries with unsafe values are skipped with a warning log.
 *
 * Returns a list of "KEY=VALUE" strings suitable for Docker's Env field.
 */
export function sanitizeEnvVars(
  envMap: Record<string, string>,
  logger: RuntimeLogger,
): string[] {
  const result: string[] = [];

  for (const [k, v] of Object.entries(envMap)) {
    if (!ENV_VAR_KEY_PATTERN.test(k)) {
      throw new ValidationError(
        'env',
        `environment variable name "${k}" is invalid (must match ^[A-Za-z_][A-Za-z0-9_]*$)`,
      );
    }

    if (v.includes('\n') || v.includes('\r') || v.includes('\x00')) {
      logger.warn('environment variable value contains unsafe characters; skipping', { key: k });
      continue;
    }

    result.push(`${k}=${v}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// parseMemoryLimit — parses human-readable memory sizes
// ---------------------------------------------------------------------------

/**
 * Parses a human-readable memory limit string to bytes.
 * Supported suffixes: k (kilobytes), m (megabytes), g (gigabytes).
 * Case-insensitive. Leading/trailing whitespace is stripped.
 *
 * Returns the byte count as a number, or null if the input is invalid.
 *
 *
 * Examples:
 *   parseMemoryLimit('512m') → 536870912
 *   parseMemoryLimit('1g')   → 1073741824
 *   parseMemoryLimit('256k') → 262144
 *   parseMemoryLimit('')     → null
 *   parseMemoryLimit('abc')  → null
 */
export function parseMemoryLimit(s: string): number | null {
  if (s === '') {
    return null;
  }

  const trimmed = s.trim().toLowerCase();
  if (trimmed === '') {
    return null;
  }

  const lastChar = trimmed[trimmed.length - 1];
  let multiplier = 1;
  let numStr = trimmed;

  if (lastChar === 'k') {
    multiplier = 1024;
    numStr = trimmed.slice(0, -1);
  } else if (lastChar === 'm') {
    multiplier = 1024 * 1024;
    numStr = trimmed.slice(0, -1);
  } else if (lastChar === 'g') {
    multiplier = 1024 * 1024 * 1024;
    numStr = trimmed.slice(0, -1);
  }

  if (numStr === '') {
    return null;
  }

  const value = parseInt(numStr, 10);
  if (isNaN(value) || value <= 0) {
    return null;
  }

  // Reject trailing non-numeric chars (e.g. "1.5m" → parseInt("1.5") = 1, but "1.5" !== "1")
  if (String(value) !== numStr) {
    return null;
  }

  return value * multiplier;
}

// ---------------------------------------------------------------------------
// errorMessage — safely extracts a message from unknown errors
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// newDockerRuntime — factory for production use
// ---------------------------------------------------------------------------

/**
 * Creates a ContainerRuntime backed by the real Docker daemon.
 * Reads connection settings from environment variables (DOCKER_HOST, etc.)
 * via dockerode's default socket path (/var/run/docker.sock).
 */
export function newDockerRuntime(imageName: string, logger: RuntimeLogger): RuntimeImpl {
  const docker = new Dockerode();
  const client = new DockerodeClient(docker);
  return new RuntimeImpl(client, imageName, logger);
}
