/**
 * Initialization helper functions.
 *
 * @module init/helpers
 */

import { LogLevel, ProviderType } from '../domain/enums.js';
import type { ResolvedProvider } from '../domain/interfaces.js';

/**
 * Parses a log level string to LogLevel enum.
 * Defaults to Info if invalid or not provided.
 */
export function parseLogLevel(level: string | undefined): LogLevel {
  switch (level?.toLowerCase()) {
    case 'trace':
      return LogLevel.Trace;
    case 'debug':
      return LogLevel.Debug;
    case 'info':
      return LogLevel.Info;
    case 'warn':
      return LogLevel.Warn;
    case 'error':
      return LogLevel.Error;
    case 'audit':
      return LogLevel.Audit;
    default:
      return LogLevel.Info;
  }
}

/**
 * Parses a listen address string (e.g., "127.0.0.1:8080") into host and port.
 */
export function parseListenAddress(address: string): { host: string; port: number } {
  const parts = address.split(':');
  if (parts.length === 2) {
    const port = parseInt(parts[1], 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return { host: parts[0], port };
    }
  }
  // Default fallback
  return { host: '127.0.0.1', port: 8080 };
}

/**
 * Parses a simple duration string (e.g., "5m", "24h", "300s") to milliseconds.
 * Supports s (seconds), m (minutes), h (hours). Falls back to defaultMs on parse failure.
 */
export function parseDurationMs(duration: string, defaultMs: number): number {
  const match = duration.match(/^(\d+)\s*(s|m|h)$/i);
  if (!match) return defaultMs;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 's') return value * 1_000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 3_600_000;
  return defaultMs;
}

/** Root workspace CLAUDE.md — instructs the SDK subprocess about MCP tools */
export const ROOT_WORKSPACE_CLAUDE_MD = `# OpenHive Assistant

You are an AI assistant running inside OpenHive. You have 27 management tools available via MCP.

## CRITICAL: Use MCP Tools for System Operations

You MUST use the following MCP tools — do NOT write files directly for these operations:

| Task | Tool to Use | Do NOT |
|------|-------------|--------|
| Remember facts | \`save_memory\` | Write to MEMORY.md directly |
| Search memories | \`recall_memory\` | Read MEMORY.md directly |
| Create an agent | \`create_agent\` | Write .claude/agents/*.md directly |
| Schedule recurring task | \`register_trigger\` | Suggest crontab or write YAML |
| Create a task for an agent | \`create_task\` | Describe what should happen without creating a task |
| Register HTTP endpoint | \`register_webhook\` | Write server config directly |

Writing files directly does NOT register them in the system. Only MCP tool calls update the database, org chart, and trigger scheduler.

## HTTP Calls

You CAN make HTTP calls. Use the built-in HTTP client:
\`\`\`bash
bun run /app/common/scripts/http-client.ts https://example.com/api --method POST --data '{"key":"value"}'
\`\`\`
This client has SSRF protection and timeout handling. You can also use curl via Bash.

## Creating Agents

When you create an agent with \`create_agent\`, include a DETAILED description that covers:
- What the agent does (full job description)
- Step-by-step instructions for its workflow
- API endpoints, credentials, entity IDs it needs
- Decision rules and thresholds
- What to do on success vs failure

Do NOT create minimal agents with just a name. The description IS the agent's system prompt.
Check if an agent already exists before creating a duplicate — use \`inspect_topology\` first.

## Web Browsing

You can browse web pages with JavaScript rendering using the \`browse_web\` tool:
- \`fetch\`: Navigate to URL, render JS, extract page text
- \`screenshot\`: Take a full-page PNG screenshot (saved to workspace)
- \`click\`: Fill forms and click buttons
- \`extract_links\`: Get all links from a page

## Available Tools (27)

**Container:** spawn_container, stop_container, list_containers
**Team:** create_team, create_agent
**Task:** create_task, dispatch_subtask, update_task_status
**Messaging:** send_message
**Orchestration:** escalate
**Memory:** save_memory, recall_memory
**Integration:** create_integration, test_integration, activate_integration
**Secrets:** get_credential, set_credential
**Query:** get_team, get_task, get_health, inspect_topology
**Event:** register_webhook, register_trigger
**Skills:** search_skill, install_skill, invoke_integration
**Browser:** browse_web
`;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Creates provider resolution functions bound to a providers config map.
 */
export function createProviderResolver(providers: Record<string, unknown>): {
  resolveProviderPreset: (presetName: string) => ResolvedProvider;
  resolveModel: (tier: string, provider: ResolvedProvider) => string;
} {
  /**
   * Resolves a named provider preset from providers.yaml into a ResolvedProvider.
   * Falls back to a safe oauth default if the preset is not found.
   */
  function resolveProviderPreset(presetName: string): ResolvedProvider {
    const preset = (providers as Record<string, Record<string, unknown>>)[presetName];
    if (!preset) {
      // No preset found in providers.yaml -- fall back to CLAUDE_CODE_OAUTH_TOKEN env var
      const envOauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      if (envOauthToken) {
        return {
          type: ProviderType.OAuth,
          oauthToken: envOauthToken,
          models: {
            haiku: 'claude-haiku-4-5-20251001',
            sonnet: 'claude-sonnet-4-6',
            opus: 'claude-opus-4-6',
          } as ResolvedProvider['models'],
        };
      }
      // No credentials available -- empty models, container will fail at SDK call time
      return { type: ProviderType.OAuth, models: {} as ResolvedProvider['models'] };
    }

    // Resolve from providers.yaml preset (takes precedence over env vars)
    const resolved: ResolvedProvider = {
      type: (preset['type'] as string) === ProviderType.AnthropicDirect
        ? ProviderType.AnthropicDirect
        : ProviderType.OAuth,
      ...(preset['api_key'] !== undefined ? { apiKey: String(preset['api_key']) } : {}),
      ...(preset['base_url'] !== undefined ? { baseUrl: String(preset['base_url']) } : {}),
      ...(preset['oauth_token'] !== undefined ? { oauthToken: String(preset['oauth_token']) } : {}),
      models: (() => {
        const explicitModels = preset['models'] as Record<string, string> | undefined;
        if (explicitModels && Object.keys(explicitModels).length > 0) return explicitModels;
        // Single-model shorthand: auto-map to all tiers
        const singleModel = preset['model'] as string | undefined;
        if (singleModel) return { haiku: singleModel, sonnet: singleModel, opus: singleModel };
        return {};
      })() as ResolvedProvider['models'],
    };

    // If preset exists but has no credentials, fall back to CLAUDE_CODE_OAUTH_TOKEN env var
    if (!resolved.apiKey && !resolved.oauthToken) {
      const envOauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      if (envOauthToken) {
        resolved.oauthToken = envOauthToken;
        resolved.type = ProviderType.OAuth;
      }
    }

    return resolved;
  }

  /**
   * Resolves a model tier string to a concrete model ID using the resolved provider.
   */
  function resolveModel(tier: string, resolvedProvider: ResolvedProvider): string {
    return (resolvedProvider.models as Record<string, string | undefined>)[tier] ?? tier;
  }

  return { resolveProviderPreset, resolveModel };
}
