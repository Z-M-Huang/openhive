/**
 * Browser tool definitions for org-MCP registry.
 *
 * Proxies @playwright/mcp tools through the BrowserRelay, with:
 * - Gate 1: Team must have `browser:` config to access any browser tool
 * - Domain allowlist validation on `browser_navigate`
 */

import { z } from 'zod';
import type { ToolDefinition, BrowserToolOrgDeps } from './registry.js';
import { validateBrowserUrl } from './url-validator.js';

/** Narrowed deps — browser tools need getTeamConfig + browserRelay + optional logger. */
export type BrowserToolDeps = BrowserToolOrgDeps & {
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
};

function gateCheck(deps: BrowserToolDeps, callerId: string): string | null {
  const config = deps.getTeamConfig(callerId);
  if (!config?.browser) {
    return 'browser tools not enabled for this team';
  }
  return null;
}

function browserTool(
  name: string,
  description: string,
  inputSchema: z.ZodType,
  deps: BrowserToolDeps,
  preCheck?: (input: Record<string, unknown>, callerId: string) => string | null,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    async handler(input: unknown, callerId: string): Promise<unknown> {
      const gateError = gateCheck(deps, callerId);
      if (gateError) {
        deps.log?.('BrowserToolCall:denied', { tool: name, callerId, reason: gateError });
        return { success: false, error: gateError };
      }

      const args = input as Record<string, unknown>;
      if (preCheck) {
        const checkError = preCheck(args, callerId);
        if (checkError) {
          deps.log?.('BrowserToolCall:denied', { tool: name, callerId, reason: checkError });
          return { success: false, error: checkError };
        }
      }

      return deps.browserRelay.callTool(name, args);
    },
  };
}

export function buildBrowserToolDefs(deps: BrowserToolDeps): ToolDefinition[] {
  const navigatePreCheck = (input: Record<string, unknown>, callerId: string): string | null => {
    const config = deps.getTeamConfig(callerId);
    const url = input.url as string;
    const result = validateBrowserUrl(url, config?.browser?.allowed_domains);
    if (!result.allowed) return result.reason ?? 'URL not allowed';
    return null;
  };

  return [
    browserTool(
      'browser_navigate',
      'Navigate to a URL in the browser. Subject to domain allowlist if configured.',
      z.object({ url: z.string() }),
      deps,
      navigatePreCheck,
    ),
    browserTool(
      'browser_snapshot',
      'Take an accessibility snapshot of the current page.',
      z.object({}).passthrough(),
      deps,
    ),
    browserTool(
      'browser_screenshot',
      'Take a visual screenshot of the current page.',
      z.object({}).passthrough(),
      deps,
    ),
    browserTool(
      'browser_click',
      'Click an element on the page.',
      z.object({ element: z.string().optional(), ref: z.string().optional() }).passthrough(),
      deps,
    ),
    browserTool(
      'browser_type',
      'Type text into an element on the page.',
      z.object({ element: z.string().optional(), ref: z.string().optional(), text: z.string() }).passthrough(),
      deps,
    ),
    browserTool(
      'browser_go_back',
      'Navigate back in browser history.',
      z.object({}).passthrough(),
      deps,
    ),
    browserTool(
      'browser_go_forward',
      'Navigate forward in browser history.',
      z.object({}).passthrough(),
      deps,
    ),
    browserTool(
      'browser_close',
      'Close the browser tab.',
      z.object({}).passthrough(),
      deps,
    ),
  ];
}
