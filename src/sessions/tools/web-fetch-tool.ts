/**
 * Inline web_fetch tool — HTTP fetch with SSRF protection.
 *
 * Uses Node.js native fetch() with:
 * - SSRF protection via url-validator (rejects private IPs, file:// URLs)
 * - 30s timeout (configurable)
 * - 1MB response body cap
 * - Audit wrapping applied centrally in message-handler.ts
 */

import { z } from 'zod';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';
import { validateBrowserUrl } from './url-validator.js';
// Note: withAudit wrapping is applied centrally in message-handler.ts.
// Do NOT add withAudit here — it would cause double-wrapping.
import { errorMessage } from '../../domain/errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576; // 1 MB

const WebFetchInputSchema = z.object({
  url: z.string().describe('The URL to fetch (http/https only)'),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional()
    .describe('HTTP method (default: GET)'),
  headers: z.record(z.string()).optional()
    .describe('Request headers'),
  body: z.string().optional()
    .describe('Request body (for POST/PUT/PATCH)'),
  timeout_ms: z.number().optional()
    .describe('Timeout in milliseconds (default: 30000, max: 60000)'),
});

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the web_fetch tool as an AI SDK inline tool definition.
 * Returns a ToolSet with a single `web_fetch` key.
 */
export function buildWebFetchTool(ctx: OrgToolContext): ToolSet {
  const execute = async (input: z.infer<typeof WebFetchInputSchema>): Promise<unknown> => {
    // SSRF protection: validate URL scheme + private IP check
    const validation = validateBrowserUrl(input.url);
    if (!validation.allowed) {
      return { success: false, error: validation.reason ?? 'URL not allowed' };
    }

    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 60_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(input.url, {
        method: input.method ?? 'GET',
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
        redirect: 'follow',
      });

      // Read body with size cap
      const reader = response.body?.getReader();
      if (!reader) {
        return {
          success: true,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: '',
          truncated: false,
        };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          truncated = true;
          // Keep only up to the cap
          const excess = totalBytes - MAX_BODY_BYTES;
          chunks.push(value.slice(0, value.byteLength - excess));
          reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }

      const body = new TextDecoder().decode(
        chunks.length === 1
          ? chunks[0]
          : new Uint8Array(chunks.reduce((acc, c) => { acc.push(...c); return acc; }, [] as number[])),
      );

      return {
        success: true,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        truncated,
      };
    } catch (err) {
      const msg = errorMessage(err);
      const isAbort = msg.includes('abort');
      return {
        success: false,
        error: isAbort ? `Request timed out after ${timeoutMs}ms` : msg,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    web_fetch: tool({
      description: 'Fetch a URL over HTTP/HTTPS. SSRF-protected: rejects private IPs and non-HTTP schemes. Response body capped at 1MB.',
      inputSchema: WebFetchInputSchema,
      execute,
    }),
  };
}
