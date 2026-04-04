/**
 * Inline browser tool builders — wraps 8 browser actions as AI SDK inline defs.
 *
 * Each tool uses bare names (e.g. "browser_navigate", not "mcp__org__browser_navigate").
 * Tools are returned in alphabetical order.
 * Returns empty `{}` when `ctx.browserRelay` is unavailable.
 *
 * Gate checks:
 * - Team must have `browser:` config to access any browser tool
 * - `browser_navigate` validates URL against domain allowlist + SSRF protection
 */

import { z } from 'zod';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';
import { validateBrowserUrl } from './url-validator.js';
// Note: withAudit wrapping is applied centrally in message-handler.ts.
// Do NOT add withAudit here — it would cause double-wrapping.

// ── Helpers ────────────────────────────────────────────────────────────────

/** Returns an error message if browser tools are not enabled for this team. */
function gateCheck(ctx: OrgToolContext): string | null {
  const config = ctx.getTeamConfig(ctx.teamName);
  if (!config?.browser) {
    return 'browser tools not enabled for this team';
  }
  return null;
}

/** Gate check wrapper — returns denial result or null to proceed. */
function denyIfGated(
  ctx: OrgToolContext,
  toolName: string,
): { success: false; error: string } | null {
  const gateError = gateCheck(ctx);
  if (gateError) {
    ctx.log('BrowserToolCall:denied', { tool: toolName, reason: gateError });
    return { success: false, error: gateError };
  }
  return null;
}

// ── Schemas ────────────────────────────────────────────────────────────────

const ClickSchema = z.object({
  element: z.string().optional(),
  ref: z.string().optional(),
}).passthrough();

const EmptySchema = z.object({}).passthrough();

const NavigateSchema = z.object({ url: z.string() });

const TypeSchema = z.object({
  element: z.string().optional(),
  ref: z.string().optional(),
  text: z.string(),
}).passthrough();

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the 8 browser tools as AI SDK inline tool definitions.
 * Returns a ToolSet keyed by bare tool name, sorted alphabetically.
 * Returns empty `{}` when `ctx.browserRelay` is unavailable.
 */
export function buildBrowserTools(ctx: OrgToolContext): ToolSet {
  if (!ctx.browserRelay?.available) return {};

  const relay = ctx.browserRelay;
  const tools: ToolSet = {};

  // 1. browser_click
  tools['browser_click'] = tool({
    description: 'Click an element on the page.',
    inputSchema: ClickSchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_click');
      if (denied) return denied;
      return relay.callTool('browser_click', input);
    },
  });

  // 2. browser_close
  tools['browser_close'] = tool({
    description: 'Close the browser tab.',
    inputSchema: EmptySchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_close');
      if (denied) return denied;
      return relay.callTool('browser_close', input);
    },
  });

  // 3. browser_go_back (Playwright MCP name: browser_navigate_back)
  tools['browser_go_back'] = tool({
    description: 'Navigate back in browser history.',
    inputSchema: EmptySchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_go_back');
      if (denied) return denied;
      return relay.callTool('browser_navigate_back', input);
    },
  });

  // 4. browser_go_forward (Playwright MCP name: browser_navigate_forward)
  tools['browser_go_forward'] = tool({
    description: 'Navigate forward in browser history.',
    inputSchema: EmptySchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_go_forward');
      if (denied) return denied;
      return relay.callTool('browser_navigate_forward', input);
    },
  });

  // 5. browser_navigate (with domain allowlist + SSRF pre-check)
  tools['browser_navigate'] = tool({
    description: 'Navigate to a URL in the browser. Subject to domain allowlist if configured.',
    inputSchema: NavigateSchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_navigate');
      if (denied) return denied;

      const config = ctx.getTeamConfig(ctx.teamName);
      const urlCheck = validateBrowserUrl(input.url, config?.browser?.allowed_domains);
      if (!urlCheck.allowed) {
        ctx.log('BrowserToolCall:denied', { tool: 'browser_navigate', reason: urlCheck.reason });
        return { success: false, error: urlCheck.reason ?? 'URL not allowed' };
      }

      return relay.callTool('browser_navigate', input);
    },
  });

  // 6. browser_screenshot (Playwright MCP name: browser_take_screenshot)
  tools['browser_screenshot'] = tool({
    description: 'Take a visual screenshot of the current page.',
    inputSchema: EmptySchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_screenshot');
      if (denied) return denied;
      return relay.callTool('browser_take_screenshot', input);
    },
  });

  // 7. browser_snapshot
  tools['browser_snapshot'] = tool({
    description: 'Take an accessibility snapshot of the current page.',
    inputSchema: EmptySchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_snapshot');
      if (denied) return denied;
      return relay.callTool('browser_snapshot', input);
    },
  });

  // 8. browser_type
  tools['browser_type'] = tool({
    description: 'Type text into an element on the page.',
    inputSchema: TypeSchema,
    execute: async (input) => {
      const denied = denyIfGated(ctx, 'browser_type');
      if (denied) return denied;
      return relay.callTool('browser_type', input);
    },
  });

  return tools;
}
