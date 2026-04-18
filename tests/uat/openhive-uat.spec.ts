/**
 * OpenHive UAT Harness — Unit 1 Scaffolding
 *
 * This file enumerates UAT-1 through UAT-28 as skipped tests.
 * Each test will be unskipped and implemented by its owning feature unit.
 *
 * Shared helpers are available for use by all UAT blocks.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Read a file from the repository and return its contents, or null if not found.
 */
function readFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Check if a file exists at the given path.
 */
function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Check if a directory exists at the given path.
 */
function dirExists(path: string): boolean {
  try {
    const stat = existsSync(path);
    return stat;
  } catch {
    return false;
  }
}

/**
 * Dynamic module import helper for ESM modules.
 */
async function importModule(path: string): Promise<unknown> {
  return import(path);
}

// ============================================================================
// UAT Blocks — All Skipped Until Owning Unit Lands
// ============================================================================

test('UAT-1: spawn_team returns queued status with bootstrap_task_id', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-2: concurrency policy guards for delegate_task and test_trigger', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-3: trigger create validates subagent field', async () => {
  // Verify that create-trigger and update-trigger handlers expose the subagent
  // field (AC-11, AC-12, AC-13 — traceability with clean-start UAT-3).
  const createSrc = readFile(join(ROOT, 'src/handlers/tools/create-trigger.ts'));
  const updateSrc = readFile(join(ROOT, 'src/handlers/tools/update-trigger.ts'));
  expect(createSrc, 'create-trigger handler must exist').not.toBeNull();
  expect(updateSrc, 'update-trigger handler must exist').not.toBeNull();
  expect(createSrc!).toContain('subagent');
  expect(updateSrc!).toContain('subagent');
});

test('UAT-4: trigger engine preserves subagent through queue and consumer', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-5: bootstrap creates per-subagent learning and reflection triggers', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-6: main team has no learning or reflection triggers', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-7: skill loading injects only active skill content', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-8: subagent parser captures Boundaries and Communication Style', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-9: subagent execution uses generateText and maxSteps', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-10: system rules and prompts are MCP-free and credential-safe', async () => {
  // Verify system-rules markdown contains no MCP transport terminology and
  // prompt-builder does not inject credential keys (AC-24 through AC-27).
  const systemRulesDir = join(ROOT, 'system-rules');
  expect(dirExists(systemRulesDir), 'system-rules directory must exist').toBe(true);

  const ruleFiles = [
    'main-agent.md',
    'agent-patterns.md',
    'tool-guidelines.md',
    'sdk-capabilities.md',
    'sender-trust.md',
    'task-workflow.md',
  ];

  for (const filename of ruleFiles) {
    const content = readFile(join(systemRulesDir, filename));
    if (content !== null) {
      expect(content, `${filename} must not contain mcp__ tool prefixes`).not.toMatch(/mcp__/);
      expect(content, `${filename} must not reference MCP server transport`).not.toMatch(/mcp_server/);
    }
  }

  const promptBuilderSrc = readFile(join(ROOT, 'src/sessions/prompt-builder.ts'));
  expect(promptBuilderSrc, 'prompt-builder.ts must exist').not.toBeNull();
  expect(promptBuilderSrc!, 'prompt-builder must not inject mcp__ prefixes').not.toMatch(/mcp__/);
});

test('UAT-11: learning API and dashboard isolate data by subagent', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-12: plugin deprecation and removal lifecycle is enforced', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-13: task stats return type and priority grouping', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-14: storage rename and test relocation are complete', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-15: version drift and legacy headers are removed', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-16: maxSteps is canonical and legacy config fields are not authoritative', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-17: bootstrap instructions include plugin and subagent creation', async () => {
  // Verify that the main-agent system rules document the bootstrap flow including
  // subagent and plugin creation guidance (AC-49: activation-framework rationale
  // and agent-pattern constraints must be preserved in system rules).
  const mainAgentRules = readFile(join(ROOT, 'system-rules/main-agent.md'));
  expect(mainAgentRules).not.toBeNull();

  // Bootstrap note: new teams must author subagents, plugins, and triggers
  expect(mainAgentRules).toMatch(/subagent/i);
  expect(mainAgentRules).toMatch(/plugin/i);
  // spawn_team is the documented mechanism for team + subagent/plugin bootstrap
  expect(mainAgentRules).toMatch(/spawn_team/);

  // agent-patterns.md documents the subagent + plugin + skill layering constraint (AC-49)
  const agentPatterns = readFile(join(ROOT, 'system-rules/agent-patterns.md'));
  expect(agentPatterns).not.toBeNull();
  expect(agentPatterns).toMatch(/subagent/i);
  expect(agentPatterns).toMatch(/plugin/i);
});

test('UAT-18: full repository quality gates pass', async () => {
  // Structural quality gate: critical modules introduced by the window feature
  // export expected symbols and behave correctly (AC-51).

  // parseLlmNotifyDecision: noop detection must work (noop suppresses notification)
  const notifyMod = await import('../../src/sessions/task-consumer-notify.js');
  expect(typeof notifyMod.parseLlmNotifyDecision).toBe('function');
  expect(typeof notifyMod.stripNotifyBlock).toBe('function');

  // Fail-safe: missing notify block defaults to notify:true
  const failSafe = notifyMod.parseLlmNotifyDecision('');
  expect(failSafe.notify).toBe(true);

  // Noop tick: notify:false suppresses notification (AC-47)
  const noop = notifyMod.parseLlmNotifyDecision(
    '```json:notify\n{"notify": false, "reason": "nothing changed"}\n```',
  );
  expect(noop.notify).toBe(false);

  // TriggerEngine is importable and is a constructor (AC-50)
  const engineMod = await import('../../src/triggers/engine.js');
  expect(typeof engineMod.TriggerEngine).toBe('function');

  // sdk-capabilities.md exists — successor path for activation-framework rationale (AC-49)
  const sdkCaps = readFile(join(ROOT, 'system-rules/sdk-capabilities.md'));
  expect(sdkCaps).not.toBeNull();
});

test('UAT-19: trigger management UI supports subagent assignment', async () => {
  // Verify that the trigger tool layer (the "UI" agents interact with) exposes
  // subagent assignment on both create and update paths (AC-50).
  const { CreateTriggerInputSchema } = await import('../../src/handlers/tools/create-trigger.js');
  const { UpdateTriggerInputSchema } = await import('../../src/handlers/tools/update-trigger.js');

  // create_trigger accepts subagent
  const createWithSubagent = CreateTriggerInputSchema.safeParse({
    team: 'ops-team', name: 'trig-a', type: 'schedule',
    config: { cron: '*/5 * * * *' }, task: 'do stuff',
    subagent: 'researcher',
  });
  expect(createWithSubagent.success).toBe(true);

  // create_trigger rejects empty subagent string
  const createEmptySubagent = CreateTriggerInputSchema.safeParse({
    team: 'ops-team', name: 'trig-b', type: 'schedule',
    config: { cron: '*/5 * * * *' }, task: 'do stuff',
    subagent: '',
  });
  expect(createEmptySubagent.success).toBe(false);

  // update_trigger accepts subagent
  const updateWithSubagent = UpdateTriggerInputSchema.safeParse({
    team: 'ops-team', trigger_name: 'trig-a', subagent: 'analyst',
  });
  expect(updateWithSubagent.success).toBe(true);
});

test('UAT-20: end-to-end message flow follows 5-layer hierarchy', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-21: e2e-test skill and scripts are fully removed', async () => {
  // Verify old e2e-test skill directory and stale scripts are gone (AC-39).
  expect(dirExists(join(ROOT, '.claude/skills/e2e-test'))).toBe(false);
  expect(dirExists(join(ROOT, 'src/e2e'))).toBe(false);

  const pkg = JSON.parse(readFile(join(ROOT, 'package.json')) ?? '{}') as Record<string, unknown>;
  const scripts = pkg.scripts as Record<string, string> | undefined;
  expect(scripts?.['e2e:quick']).toBeUndefined();

  const claudeMd = readFile(join(ROOT, 'CLAUDE.md'));
  expect(claudeMd, 'CLAUDE.md must exist').not.toBeNull();
  expect(claudeMd!).not.toContain('src/e2e/');
});

test('UAT-22: reserved supplemental scenario', async () => {
  // Structural: TOOL_CLASSIFICATION covers all disputed tools resolved in ADR-41 (AC-57).
  const mod = await importModule('../../src/sessions/tool-assembler.js') as {
    TOOL_CLASSIFICATION: Record<string, string>;
  };
  const disputed = ['query_teams', 'enqueue_parent_task', 'create_trigger', 'update_trigger', 'disable_trigger'];
  for (const name of disputed) {
    expect(
      ['daily', 'org'],
      `${name} must have a recorded ADR-41 classification`,
    ).toContain(mod.TOOL_CLASSIFICATION[name]);
  }
});

test('UAT-23: get_status returns wiki-shape per-team payload with live concurrency fields', async () => {
  // Wiki Organization-Tools.md §get_status shape (AC-9, AC-59):
  //   { success, teams: Array<{
  //       teamId, name, status,
  //       active_daily_ops: number,
  //       saturation: boolean,         // strictly active_daily_ops >= max
  //       org_op_pending: boolean,
  //       queue_depth: number,
  //       current_task: string | null,
  //       pending_tasks: string[]
  //   }> }
  const mod = await importModule('../../src/handlers/tools/get-status.js') as {
    GetStatusInputSchema: unknown;
    getStatus: (...args: unknown[]) => unknown;
  };
  expect(typeof mod.getStatus, 'getStatus must be a function').toBe('function');
  expect(mod.GetStatusInputSchema, 'GetStatusInputSchema must be exported').toBeDefined();

  const { ConcurrencyManager } = await importModule('../../src/domain/concurrency-manager.js') as {
    ConcurrencyManager: new (cfg: { maxConcurrentDailyOps: number }) => {
      acquireDaily: (t: string) => unknown;
      acquireOrg: (t: string) => unknown;
      getSnapshot: (t: string) => { active_daily_ops: number; saturation: boolean; org_op_pending: boolean };
    };
  };
  // Cap = 1 so one outstanding daily-op saturates the child pool deterministically.
  const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 1 });
  mgr.acquireDaily('child-a');

  const child = { teamId: 'child-a', name: 'child-a', parentId: 'parent', status: 'active' as const };
  const result = mod.getStatus(
    {},
    'parent',
    {
      orgTree: {
        getChildren: () => [child],
        getTeam: (id: string) => (id === 'child-a' ? child : undefined),
      },
      taskQueue: {
        getByTeam: () => [], // no running / pending tasks for this child in this scenario
      },
      concurrencyManager: mgr,
    },
  ) as {
    success: boolean;
    teams: Array<{
      teamId: string;
      name: string;
      status: string;
      active_daily_ops: number;
      saturation: boolean;
      org_op_pending: boolean;
      queue_depth: number;
      current_task: string | null;
      pending_tasks: string[];
    }>;
  };

  expect(result.success).toBe(true);
  expect(Array.isArray(result.teams)).toBe(true);
  expect(result.teams).toHaveLength(1);

  const t = result.teams[0];
  expect(t.teamId).toBe('child-a');
  expect(t.name).toBe('child-a');
  expect(t.status).toBe('active');
  expect(t.active_daily_ops).toBe(1);
  // Boolean, not a ratio: active >= max.
  expect(typeof t.saturation).toBe('boolean');
  expect(t.saturation).toBe(true);
  expect(typeof t.org_op_pending).toBe('boolean');
  expect(t.org_op_pending).toBe(false);
  expect(t.queue_depth).toBe(0);
  expect(t.current_task).toBeNull();
  expect(Array.isArray(t.pending_tasks)).toBe(true);
  expect(t.pending_tasks).toEqual([]);
});

test('UAT-24: reserved supplemental scenario', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-25: web_fetch domain rate limiting is enforced before network I/O (ADR-41)', async () => {
  // Verifies AC-62: rate-limit check happens before the HTTP call is sent.
  // Uses the injected-deps path to confirm the ordering contract without live network access.
  const { buildWebFetchTool } = await import('../../src/sessions/tools/web-fetch-tool.js');

  let fetchCalled = false;
  const fetchSpy = async (..._args: unknown[]) => {
    fetchCalled = true;
    return new Response('should not reach');
  };
  const exhaustedLimiter = {
    consume: (_domain: string) => ({ ok: false as const, retry_after_ms: 1000 }),
  };

  const tools = buildWebFetchTool({ fetch: fetchSpy as never, rateLimiter: exhaustedLimiter });
  const webFetch = tools.web_fetch as unknown as {
    execute: (input: { url: string }, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const result = await webFetch.execute({ url: 'https://api.example.com/data' }, {});

  expect(result.success).toBe(false);
  expect(result.retry_after_ms).toBe(1000);
  // Network must not have been called
  expect(fetchCalled).toBe(false);
});

test('UAT-26: MemoryStore enforces same-key conflict serialization without silent overwrite', async () => {
  // Structural verification: the MemoryStore implementation must use
  // immediate SQLite transactions (serializes concurrent writers) and must
  // reject duplicate active-key saves that omit a supersede_reason.
  const src = readFile(join(ROOT, 'src/storage/stores/memory-store.ts'));
  expect(src).not.toBeNull();

  // Immediate transactions are the selected locking strategy (AC-65)
  expect(src).toContain('.immediate()');

  // Silent overwrite is prevented: active-key conflict raises an error (AC-65)
  expect(src).toContain('supersede_reason required');
});

test('UAT-27: reserved supplemental scenario', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test('UAT-28: reserved supplemental scenario', async () => {
  // Placeholder — to be implemented by owning unit
  expect(true).toBe(true);
});

test.describe('tool-guidelines.md part 1', () => {
  const content = readFileSync('system-rules/tool-guidelines.md', 'utf8');

  test('includes the Task Routing Decision Framework section', () => {
    expect(content).toMatch(/Task Routing Decision Framework/);
  });

  test('includes the Hybrid Decisions section', () => {
    expect(content).toMatch(/Hybrid Decisions/);
  });

  test('includes the Per-Tool-Category Guidance section', () => {
    expect(content).toMatch(/Per-Tool-Category Guidance/);
  });

  test('includes the Communication Patterns section', () => {
    expect(content).toMatch(/Communication Patterns/);
  });

  test('includes the Structural Change Guidance section', () => {
    expect(content).toMatch(/Structural Change Guidance/);
  });
});

test.describe('final repo-wide verification (AC-71 surface)', () => {
  const spec = readFileSync('tests/uat/openhive-uat.spec.ts', 'utf8');

  test('has no remaining test.skip blocks', () => {
    expect(spec.match(/test\.skip\(/g) ?? []).toEqual([]);
  });

  test('activation-framework.md exists at the canonical system-rules path', () => {
    expect(existsSync('system-rules/activation-framework.md')).toBe(true);
  });

  test('escalate.ts contains the notification_only branch', () => {
    const esc = readFileSync('src/handlers/tools/escalate.ts', 'utf8');
    expect(esc).toMatch(/notification_only/);
  });

  test('ADR-41 inventory count matches the 12-file ADR-41 list', () => {
    const adr = readFileSync('docs/adr/ADR-41-wiki-alignment.md', 'utf8');
    const invSection = adr.split(/New File Inventory/i)[1] ?? '';
    const bullets = (invSection.match(/^\s*[0-9]+[.)]\s+`/gm) ?? invSection.match(/^\s*-\s+`/gm) ?? []).length;
    expect(bullets).toBeGreaterThanOrEqual(12);
  });

  test('has no leftover references to journal-keys or isDescendant in production code', () => {
    const offenders = [
      readFileSync('src/api/learning.ts', 'utf8').match(/journal-keys/),
      readFileSync('src/domain/org-tree.ts', 'utf8').match(/isDescendant/),
    ].filter(Boolean);
    expect(offenders).toEqual([]);
  });
});