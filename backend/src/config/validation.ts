/**
 * OpenHive Backend - Config Validation
 *
 * Functions:
 *   validateMasterConfig(cfg) — validates all required fields in MasterConfig
 *   validateProviders(providers) — validates a map of provider presets
 *
 * All validators throw ValidationError on invalid input.
 */

import { ValidationError } from '../domain/errors.js';
import { parseLogLevel, parseModelTier } from '../domain/enums.js';
import { validateAID, validateAgent, validateProvider } from '../domain/validation.js';
import type { MasterConfig, Provider } from '../domain/types.js';

// ---------------------------------------------------------------------------
// validateMasterConfig
// ---------------------------------------------------------------------------

/**
 * Validates a MasterConfig object.
 *
 * Checks:
 *   - system.listen_address not empty
 *   - system.data_dir not empty
 *   - system.workspace_root not empty
 *   - system.log_level is a valid LogLevel (if non-empty)
 *   - assistant.name not empty
 *   - assistant.aid is a valid AID (if non-empty)
 *   - assistant.provider not empty
 *   - assistant.model_tier is a valid ModelTier (if non-empty)
 *   - each agent in cfg.agents passes validateAgent
 *
 * Throws ValidationError on the first invalid field found.
 */
export function validateMasterConfig(cfg: MasterConfig): void {
  if (cfg.system.listen_address === '') {
    throw new ValidationError('system.listen_address', 'cannot be empty');
  }

  if (cfg.system.data_dir === '') {
    throw new ValidationError('system.data_dir', 'cannot be empty');
  }

  if (cfg.system.workspace_root === '') {
    throw new ValidationError('system.workspace_root', 'cannot be empty');
  }

  if (cfg.system.log_level !== '') {
    try {
      parseLogLevel(cfg.system.log_level);
    } catch {
      throw new ValidationError(
        'system.log_level',
        'invalid log level: ' + cfg.system.log_level,
      );
    }
  }

  if (cfg.assistant.name === '') {
    throw new ValidationError('assistant.name', 'cannot be empty');
  }

  if (cfg.assistant.aid !== '') {
    validateAID(cfg.assistant.aid);
  }

  if (cfg.assistant.provider === '') {
    throw new ValidationError('assistant.provider', 'cannot be empty');
  }

  if (cfg.assistant.model_tier !== '') {
    try {
      parseModelTier(cfg.assistant.model_tier);
    } catch {
      throw new ValidationError(
        'assistant.model_tier',
        'invalid model tier: ' + cfg.assistant.model_tier,
      );
    }
  }

  const agents = cfg.agents ?? [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    try {
      validateAgent(agent);
    } catch (err) {
      throw new ValidationError(
        `agents[${i}]`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// validateProviders
// ---------------------------------------------------------------------------

/**
 * Validates a map of provider presets.
 *
 * Checks:
 *   - At least one provider must be defined
 *   - Each provider passes validateProvider (with name set from map key)
 *
 * Throws ValidationError on the first invalid provider found.
 */
export function validateProviders(providers: Record<string, Provider>): void {
  if (Object.keys(providers).length === 0) {
    throw new ValidationError('providers', 'at least one provider preset must be defined');
  }

  for (const [name, p] of Object.entries(providers)) {
    const providerWithName: Provider = { ...p, name };
    try {
      validateProvider(providerWithName);
    } catch (err) {
      throw new ValidationError(
        'providers.' + name,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
