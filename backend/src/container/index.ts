/**
 * OpenHive Backend - Container Package Barrel Export
 *
 * Re-exports all public symbols from the container package:
 *   - RuntimeImpl (low-level Docker operations via ContainerRuntime)
 *   - ManagerImpl (high-level lifecycle management via ContainerManager)
 *   - Factory functions and utility exports
 */

export {
  RuntimeImpl,
  newDockerRuntime,
  mapDockerState,
  sanitizeEnvVars,
  parseMemoryLimit,
  OPENHIVE_NETWORK_NAME,
  CONTAINER_NAME_PREFIX,
  DEFAULT_MEMORY_LIMIT,
} from './runtime.js';

export type { DockerClient, DockerContainer, RuntimeLogger } from './runtime.js';

export {
  ManagerImpl,
  newContainerManager,
  restartBackoffForAttempt,
} from './manager.js';

export type { ManagerConfig, ManagerLogger, ManagerWSHub } from './manager.js';
