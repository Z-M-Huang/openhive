/**
 * OpenHive Agent Runner - Shared type definitions
 *
 * These types mirror the Go domain types and WebSocket protocol messages.
 */

/** Agent status types matching Go enum */
export type AgentStatusType = 'idle' | 'busy' | 'starting' | 'stopped' | 'error';

/** Model tier types matching Go enum */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Provider type */
export type ProviderType = 'oauth' | 'anthropic_direct';

/** Task status */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Agent configuration received during container init */
export interface AgentInitConfig {
  aid: string;
  name: string;
  roleFile: string;
  promptFile: string;
  provider: ProviderConfig;
  modelTier: ModelTier;
  skills: string[];
  maxTurns: number;
  timeoutMinutes: number;
}

/** Flattened provider configuration */
export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  oauthToken?: string;
  models: Record<ModelTier, string>;
}

/** Agent status reported in heartbeat */
export interface AgentStatus {
  aid: string;
  status: AgentStatusType;
  detail: string;
  elapsedSeconds: number;
  memoryMB: number;
}
