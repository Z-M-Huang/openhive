/**
 * OpenHive Backend - Config Module Barrel Export
 *
 * Re-exports all public symbols from the config package for convenient
 * consumption by other modules.
 */

// ConfigLoader (main class + factory)
export { ConfigLoaderImpl, newConfigLoader } from './loader.js';

// Master config file I/O
export {
  loadMasterFromFile,
  saveMasterToFile,
  getConfigSection,
  getConfigSectionByName,
  updateConfigField,
  applyEnvOverrides,
} from './master.js';
export type { ConfigSectionName, ConfigSectionType } from './master.js';

// Providers file I/O
export { loadProvidersFromFile, saveProvidersToFile, resolveProviderEnv } from './providers.js';

// Team file I/O
export {
  validateTeamPath,
  loadTeamFromFile,
  saveTeamToFile,
  createTeamDirectory,
} from './team.js';

// File watcher
export { FileWatcher } from './watcher.js';

// Defaults
export { defaultMasterConfig } from './defaults.js';

// Validation
export { validateMasterConfig, validateProviders } from './validation.js';

// OrgChart
export { OrgChartService, newOrgChart } from './orgchart.js';
