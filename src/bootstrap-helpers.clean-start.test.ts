import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as bootstrapHelpers from './bootstrap-helpers.js';
import type { ITriggerConfigStore } from './domain/interfaces.js';
import type { TriggerConfig } from './domain/types.js';

describe('bootstrap-helpers clean start', () => {
  it('should not export seedTeamSkills', () => {
    expect('seedTeamSkills' in bootstrapHelpers).toBe(false);
  });

  it('should not export runMemoryMigration', () => {
    expect('runMemoryMigration' in bootstrapHelpers).toBe(false);
  });

  it('should not export runVaultMigration', () => {
    expect('runVaultMigration' in bootstrapHelpers).toBe(false);
  });

  it('should not export migrateAllowedTools', () => {
    expect('migrateAllowedTools' in bootstrapHelpers).toBe(false);
  });

  it('should not have migration.ts file', () => {
    const filePath = path.join(__dirname, 'storage', 'migration.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should not have migration-vault.ts file', () => {
    const filePath = path.join(__dirname, 'storage', 'migration-vault.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should not have migration-vault.test.ts file', () => {
    const filePath = path.join(__dirname, 'storage', 'migration-vault.test.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

/**
 * In-memory stub of ITriggerConfigStore — records all mutations so the tests
 * can assert seeding and cleanup behavior without standing up real SQLite.
 */
class InMemoryTriggerStore implements ITriggerConfigStore {
  readonly rows = new Map<string, TriggerConfig>();
  private key(team: string, name: string): string { return `${team}::${name}`; }
  upsert(cfg: TriggerConfig): void { this.rows.set(this.key(cfg.team, cfg.name), { ...cfg }); }
  remove(team: string, name: string): void { this.rows.delete(this.key(team, name)); }
  removeByTeam(team: string): void {
    for (const k of [...this.rows.keys()]) if (k.startsWith(`${team}::`)) this.rows.delete(k);
  }
  get(team: string, name: string): TriggerConfig | undefined { return this.rows.get(this.key(team, name)); }
  getByTeam(team: string): TriggerConfig[] {
    return [...this.rows.values()].filter(r => r.team === team);
  }
  getAll(): TriggerConfig[] { return [...this.rows.values()]; }
  setState(): void { /* unused in these tests */ }
  incrementFailures(): number { return 0; }
  resetFailures(): void { /* unused in these tests */ }
  setActiveTask(): void { /* unused */ }
  clearActiveTask(): void { /* unused */ }
  setOverlapCount(): void { /* unused */ }
  resetOverlapState(): void { /* unused */ }
}

describe('seedLearningTriggers main-team exception (AC-19)', () => {
  let runDir: string;
  let store: InMemoryTriggerStore;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-bootstrap-'));
    fs.mkdirSync(path.join(runDir, 'teams', 'main', 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'teams', 'alpha', 'subagents'), { recursive: true });
    store = new InMemoryTriggerStore();
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('does not seed learning-cycle or reflection-cycle for main team', () => {
    bootstrapHelpers.seedLearningTriggers(runDir, store);
    const mainRows = store.getByTeam('main');
    const mainCycleRows = mainRows.filter(r =>
      r.name.startsWith('learning-cycle') || r.name.startsWith('reflection-cycle'),
    );
    expect(mainCycleRows).toHaveLength(0);
  });

  it('still seeds learning-cycle and reflection-cycle for non-main teams', () => {
    bootstrapHelpers.seedLearningTriggers(runDir, store);
    expect(store.get('alpha', 'learning-cycle')).toBeDefined();
    expect(store.get('alpha', 'reflection-cycle')).toBeDefined();
  });

  it('removes pre-existing main learning-cycle and reflection-cycle rows during bootstrap', () => {
    store.upsert({
      name: 'learning-cycle', type: 'schedule', team: 'main',
      config: { cron: '0 2 * * *' }, task: 't', state: 'active',
    });
    store.upsert({
      name: 'reflection-cycle', type: 'schedule', team: 'main',
      config: { cron: '0 3 * * *' }, task: 't', state: 'active',
    });
    store.upsert({
      name: 'learning-cycle-planner', type: 'schedule', team: 'main',
      config: { cron: '0 2 * * *' }, task: 't', subagent: 'planner', state: 'active',
    });
    bootstrapHelpers.seedLearningTriggers(runDir, store);
    expect(store.get('main', 'learning-cycle')).toBeUndefined();
    expect(store.get('main', 'reflection-cycle')).toBeUndefined();
    expect(store.get('main', 'learning-cycle-planner')).toBeUndefined();
  });

  it('cleanMainTeamCycleTriggers preserves non-cycle rows on main', () => {
    store.upsert({
      name: 'learning-cycle', type: 'schedule', team: 'main',
      config: { cron: '0 2 * * *' }, task: 't', state: 'active',
    });
    store.upsert({
      name: 'custom-trigger', type: 'schedule', team: 'main',
      config: { cron: '0 4 * * *' }, task: 'custom', state: 'active',
    });
    bootstrapHelpers.cleanMainTeamCycleTriggers(store);
    expect(store.get('main', 'learning-cycle')).toBeUndefined();
    expect(store.get('main', 'custom-trigger')).toBeDefined();
  });
});