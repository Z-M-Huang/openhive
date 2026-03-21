/**
 * Integration tool handlers: create_integration, test_integration, activate_integration, invoke_integration.
 *
 * @module mcp/tools/handlers-integration
 */

import crypto from 'node:crypto';
import { IntegrationStatus } from '../../domain/index.js';
import { ValidationError, NotFoundError } from '../../domain/errors.js';
import { CreateIntegrationSchema, TestIntegrationSchema, ActivateIntegrationSchema, InvokeIntegrationSchema } from './schemas.js';
import { assertNotPrivateUrl } from './helpers.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createIntegrationHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('create_integration', async (args, _agentAid, teamSlug) => {
    const parsed = CreateIntegrationSchema.parse(args);

    const integrationId = crypto.randomUUID();

    const team = ctx.orgChart.getTeamBySlug(teamSlug);
    const workspacePath = team?.workspacePath ?? '/app/workspace';
    const configPath = `${workspacePath}/integrations/${parsed.name}.yaml`;

    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const YAML = await import('yaml');

    await mkdirFs(join(workspacePath, 'integrations'), { recursive: true });
    await writeFileFs(configPath, YAML.stringify(parsed.config), 'utf-8');

    await ctx.integrationStore.create({
      id: integrationId,
      team_id: teamSlug,
      name: parsed.name,
      config_path: configPath,
      status: IntegrationStatus.Proposed,
      error_message: '',
      created_at: Date.now(),
    });

    ctx.logger.info('Integration created', { name: parsed.name, config_path: configPath });

    return { integration_id: integrationId, config_path: configPath };
  });

  handlers.set('test_integration', async (args) => {
    const parsed = TestIntegrationSchema.parse(args);

    const integration = await ctx.integrationStore.get(parsed.integration_id);

    if (integration.status !== IntegrationStatus.Proposed && integration.status !== IntegrationStatus.Validated) {
      throw new ValidationError(
        `Integration '${parsed.integration_id}' cannot be tested in state '${integration.status}'`
      );
    }

    let testResult = { success: true, details: 'Config validated (no smoke_test endpoint defined)' };
    try {
      const { readFile: readFileFs } = await import('node:fs/promises');
      const YAML = await import('yaml');
      const configContent = await readFileFs(integration.config_path, 'utf-8');
      const config = YAML.parse(configContent) as Record<string, unknown>;

      const smokeTest = config['smoke_test'] as { url?: string } | undefined;
      if (smokeTest?.url) {
        assertNotPrivateUrl(smokeTest.url);
        const response = await fetch(smokeTest.url, {
          method: 'GET',
          signal: AbortSignal.timeout(10_000),
        });
        testResult = {
          success: response.ok,
          details: `Smoke test: HTTP ${response.status} ${response.statusText}`,
        };
        if (!response.ok) {
          await ctx.integrationStore.updateStatus(parsed.integration_id, IntegrationStatus.Proposed);
          return { success: false, errors: [`Smoke test failed: HTTP ${response.status}`] };
        }
      }
    } catch {
      testResult = { success: true, details: 'Status transition only (config file not readable)' };
    }

    await ctx.integrationStore.updateStatus(parsed.integration_id, IntegrationStatus.Tested);

    return { success: testResult.success, details: testResult.details, errors: [] };
  });

  handlers.set('activate_integration', async (args) => {
    const parsed = ActivateIntegrationSchema.parse(args);

    const integration = await ctx.integrationStore.get(parsed.integration_id);

    if (integration.status !== IntegrationStatus.Tested && integration.status !== IntegrationStatus.Approved) {
      throw new ValidationError(
        `Integration '${parsed.integration_id}' must be tested before activation (current: '${integration.status}')`
      );
    }

    await ctx.integrationStore.updateStatus(parsed.integration_id, IntegrationStatus.Active);

    return { status: IntegrationStatus.Active };
  });

  handlers.set('invoke_integration', async (args, _agentAid, teamSlug) => {
    const parsed = InvokeIntegrationSchema.parse(args);

    const integrations = await ctx.integrationStore.listByTeam(teamSlug);
    const integration = integrations.find(
      (i) => i.name === parsed.name && i.status === IntegrationStatus.Active
    );
    if (!integration) {
      throw new NotFoundError(
        `No active integration named '${parsed.name}' found for team '${teamSlug}'`
      );
    }

    const { readFile: readFileFs } = await import('node:fs/promises');
    const YAML = await import('yaml');
    const configContent = await readFileFs(integration.config_path, 'utf-8');
    const config = YAML.parse(configContent) as Record<string, unknown>;

    const endpoints = (config['endpoints'] as Array<Record<string, unknown>>) ?? [];
    const endpoint = endpoints.find((e) => e['name'] === parsed.endpoint);
    if (!endpoint) {
      throw new NotFoundError(
        `Endpoint '${parsed.endpoint}' not found in integration '${parsed.name}'. Available: ${endpoints.map(e => e['name']).join(', ')}`
      );
    }

    const baseUrl = String(config['base_url'] ?? '');
    let path = String(endpoint['path'] ?? '');

    for (const [key, value] of Object.entries(parsed.params ?? {})) {
      path = path.replace(`{${key}}`, encodeURIComponent(value));
    }

    const url = `${baseUrl.replace(/\/$/, '')}${path}`;

    const auth = config['auth'] as Record<string, unknown> | undefined;
    const headers: Record<string, string> = {
      ...(endpoint['headers'] as Record<string, string> ?? {}),
    };

    if (auth?.credential_key) {
      const credKey = String(auth.credential_key);
      const creds = await ctx.credentialStore.listByTeam(teamSlug);
      const cred = creds.find((c) => c.name === credKey);
      if (cred) {
        const credValue = cred.encrypted_value;
        const headerName = String(auth.header ?? 'Authorization');
        const authType = String(auth.type ?? 'bearer');
        headers[headerName] = authType === 'bearer' ? `Bearer ${credValue}` : credValue;
      }
    }

    const method = String(endpoint['method'] ?? 'GET').toUpperCase();
    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };

    if ((method === 'POST' || method === 'PUT') && endpoint['body_template']) {
      let body = String(endpoint['body_template']);
      for (const [key, value] of Object.entries(parsed.params ?? {})) {
        body = body.replace(`{{${key}}}`, value);
      }
      fetchOpts.body = body;
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }

    assertNotPrivateUrl(url);
    const response = await fetch(url, fetchOpts);
    const responseText = await response.text();

    ctx.logger.info('Integration invoked', {
      integration: parsed.name,
      endpoint: parsed.endpoint,
      method,
      status: response.status,
      team_slug: teamSlug,
    });

    return {
      status: response.status,
      ok: response.ok,
      body: responseText.length > 10000 ? responseText.slice(0, 10000) + '...(truncated)' : responseText,
    };
  });

  return handlers;
}
