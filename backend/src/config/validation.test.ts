import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  validateMasterConfig,
  validateProviders,
  validateTeam,
  masterConfigSchema,
  providerConfigSchema,
  teamConfigSchema,
} from './validation.js';
import { defaultMasterConfig } from './defaults.js';

describe('Config Validation', () => {
  describe('validateMasterConfig', () => {
    it('AC-16: defaultMasterConfig() passes validateMasterConfig() (backward-compat gate)', () => {
      const config = defaultMasterConfig();
      expect(() => validateMasterConfig(config)).not.toThrow();
    });

    it('rejects invalid server.log_level', () => {
      const config = {
        ...defaultMasterConfig(),
        server: { ...defaultMasterConfig().server, log_level: 'invalid' },
      };
      expect(() => validateMasterConfig(config)).toThrow(ZodError);
      try {
        validateMasterConfig(config);
      } catch (e) {
        if (e instanceof ZodError) {
          expect(e.errors[0].path.join('.')).toContain('server.log_level');
        } else {
          throw e;
        }
      }
    });

    it('rejects invalid assistant.aid', () => {
      const config = {
        ...defaultMasterConfig(),
        assistant: { ...defaultMasterConfig().assistant, aid: 'bad-id' },
      };
      expect(() => validateMasterConfig(config)).toThrow(ZodError);
      try {
        validateMasterConfig(config);
      } catch (e) {
        if (e instanceof ZodError) {
          expect(e.errors[0].path.join('.')).toContain('assistant.aid');
        } else {
          throw e;
        }
      }
    });

    it('rejects missing required field server.listen_address', () => {
      const config = defaultMasterConfig();
      // @ts-expect-error - intentionally testing missing field
      delete config.server.listen_address;
      expect(() => validateMasterConfig(config)).toThrow(ZodError);
    });

    it('accepts new optional fields triggers, skill_registries, agents', () => {
      const config = {
        ...defaultMasterConfig(),
        triggers: [
          {
            name: 'test-trigger',
            target_team: 'test-team',
            type: 'cron',
            schedule: '0 * * * *',
            prompt: 'Run hourly',
          },
        ],
        skill_registries: ['test-registry'],
        agents: [
          { aid: 'aid-test-001', name: 'Test Agent', leads_team: 'test-team' },
        ],
      };
      expect(() => validateMasterConfig(config)).not.toThrow();
      const result = validateMasterConfig(config);
      expect(result.triggers).toHaveLength(1);
      expect(result.skill_registries).toEqual(['test-registry']);
      expect(result.agents).toHaveLength(1);
    });

    it('accepts optional providers field', () => {
      const config = {
        ...defaultMasterConfig(),
        providers: 'custom-provider',
      };
      expect(() => validateMasterConfig(config)).not.toThrow();
      const result = validateMasterConfig(config);
      expect(result.providers).toBe('custom-provider');
    });

    it('rejects unknown fields at top level (strict mode)', () => {
      const config = {
        ...defaultMasterConfig(),
        unknown_field: 'should fail',
      };
      expect(() => validateMasterConfig(config)).toThrow(ZodError);
    });

    it('error messages do not contain secret values', () => {
      const config = defaultMasterConfig();
      // @ts-expect-error - intentionally testing invalid field
      config.server.listen_address = 12345; // wrong type
      try {
        validateMasterConfig(config);
      } catch (e) {
        if (e instanceof ZodError) {
          const errorMessage = e.message;
          expect(errorMessage).not.toContain('12345');
        } else {
          throw e;
        }
      }
    });
  });

  describe('validateProviders', () => {
    it('rejects empty providers map', () => {
      expect(() => validateProviders({})).toThrow(ZodError);
    });

    it('accepts valid oauth provider', () => {
      const providers = {
        oauth_provider: {
          type: 'oauth' as const,
          oauth_token: 'test-token-secret',
          models: { haiku: 'claude-3-haiku-20240307' },
        },
      };
      expect(() => validateProviders(providers)).not.toThrow();
      const result = validateProviders(providers);
      expect(result).toEqual(providers);
    });

    it('accepts valid anthropic_direct provider', () => {
      const providers = {
        direct_provider: {
          type: 'anthropic_direct' as const,
          api_key: 'sk-ant-test-key',
          base_url: 'https://api.anthropic.com',
          models: { sonnet: 'claude-3-5-sonnet-20241022' },
        },
      };
      expect(() => validateProviders(providers)).not.toThrow();
      const result = validateProviders(providers);
      expect(result).toEqual(providers);
    });

    it('rejects provider with type oauth but missing oauth_token', () => {
      const providers = {
        oauth_provider: {
          type: 'oauth' as const,
          // missing oauth_token
        },
      };
      expect(() => validateProviders(providers)).toThrow(ZodError);
    });

    it('rejects provider with type anthropic_direct but missing api_key', () => {
      const providers = {
        direct_provider: {
          type: 'anthropic_direct' as const,
          // missing api_key
        },
      };
      expect(() => validateProviders(providers)).toThrow(ZodError);
    });

    it('rejects unknown provider type', () => {
      const providers = {
        unknown_provider: {
          type: 'unknown_type' as never,
          oauth_token: 'test',
        },
      };
      expect(() => validateProviders(providers)).toThrow(ZodError);
    });

    it('rejects extra fields on oauth provider (strict mode)', () => {
      const providers = {
        oauth_provider: {
          type: 'oauth' as const,
          oauth_token: 'test-token',
          extra_field: 'should fail',
        },
      };
      expect(() => validateProviders(providers)).toThrow(ZodError);
    });

    it('rejects extra fields on anthropic_direct provider (strict mode)', () => {
      const providers = {
        direct_provider: {
          type: 'anthropic_direct' as const,
          api_key: 'test-key',
          extra_field: 'should fail',
        },
      };
      expect(() => validateProviders(providers)).toThrow(ZodError);
    });

    it('error messages do not contain secret values', () => {
      const providers = {
        oauth_provider: {
          type: 'oauth' as const,
          oauth_token: 'secret-token-12345',
        },
      };
      try {
        validateProviders(providers);
      } catch (e) {
        if (e instanceof ZodError) {
          const errorMessage = e.message;
          expect(errorMessage).not.toContain('secret-token-12345');
        } else {
          throw e;
        }
      }
    });
  });

  describe('validateTeam', () => {
    it('accepts valid team with slug and leader_aid', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      expect(result.slug).toBe('test-team');
      expect(result.leader_aid).toBe('aid-lead-001');
    });

    it('rejects invalid slug format (uppercase)', () => {
      const team = {
        slug: 'BAD-SLUG',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects invalid slug format (special chars)', () => {
      const team = {
        slug: 'bad_slug',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects slug too short (less than 3 chars)', () => {
      const team = {
        slug: 'ab',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects slug longer than 63 characters', () => {
      const longSlug = 'a'.repeat(64);
      const team = {
        slug: longSlug,
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects reserved slug "root"', () => {
      const team = {
        slug: 'root',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects reserved slug "main"', () => {
      const team = {
        slug: 'main',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects reserved slug "admin"', () => {
      const team = {
        slug: 'admin',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects reserved slug "system"', () => {
      const team = {
        slug: 'system',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects reserved slug "openhive"', () => {
      const team = {
        slug: 'openhive',
        leader_aid: 'aid-lead-001',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects invalid leader_aid format', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'invalid-id',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('rejects invalid nested agents[*].aid format', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        agents: [
          {
            aid: 'not-a-valid-aid',
            name: 'Bad Agent',
          },
        ],
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('accepts valid tid in team config', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        tid: 'tid-123-456',
      };
      expect(() => validateTeam(team)).not.toThrow();
    });

    it('rejects invalid tid format', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        tid: 'bad-tid',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });

    it('accepts optional fields: description, agents, triggers', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        description: 'Test team description',
        agents: [
          {
            aid: 'aid-member-001',
            name: 'Member Agent',
            model_tier: 'haiku',
          },
        ],
        triggers: [
          {
            name: 'daily-trigger',
            target_team: 'test-team',
            type: 'cron',
            schedule: '0 0 * * *',
            prompt: 'Daily check',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      expect(result.description).toBe('Test team description');
      expect(result.agents).toHaveLength(1);
      expect(result.triggers).toHaveLength(1);
    });

    it('rejects unknown fields at top level (strict mode)', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        unknown_field: 'should fail',
      };
      expect(() => validateTeam(team)).toThrow(ZodError);
    });
  });

  describe('Trigger target_team / team_slug backward compatibility (AC-E1, AC-CROSS-5)', () => {
    it('accepts trigger with target_team field', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'new-trigger',
            target_team: 'my-team',
            type: 'cron',
            schedule: '0 * * * *',
            prompt: 'Hourly check',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      expect(result.triggers![0]!.target_team).toBe('my-team');
    });

    it('accepts legacy team_slug and maps it to target_team', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'legacy-trigger',
            team_slug: 'legacy-team',
            type: 'cron',
            schedule: '0 * * * *',
            prompt: 'Legacy check',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      expect(result.triggers![0]!.target_team).toBe('legacy-team');
    });

    it('when both team_slug and target_team provided, target_team wins', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'both-fields',
            team_slug: 'old-team',
            target_team: 'new-team',
            type: 'cron',
            schedule: '0 * * * *',
            prompt: 'Check',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      expect(result.triggers![0]!.target_team).toBe('new-team');
    });

    it('trigger missing both team_slug and target_team fails validation', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'bad-trigger',
            type: 'cron',
            schedule: '0 * * * *',
            prompt: 'Check',
          },
        ],
      };
      expect(() => validateTeam(team)).toThrow();
    });

    it('accepts webhook trigger with target_team', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'wh-trigger',
            target_team: 'webhook-team',
            type: 'webhook',
            path: 'my-hook',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
    });

    it('accepts legacy team_slug on webhook trigger', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'wh-legacy',
            team_slug: 'legacy-team',
            type: 'webhook',
            path: 'my-hook',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      expect(result.triggers![0]!.target_team).toBe('legacy-team');
    });
  });

  describe('Cron trigger action field and agent field (AC-E2)', () => {
    it('accepts nested action object on cron trigger', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'action-trigger',
            target_team: 'my-team',
            type: 'cron',
            schedule: '0 * * * *',
            action: { title: 'Hourly report', prompt: 'Generate hourly report', priority: 'P1' },
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      const trigger = result.triggers![0]!;
      expect(trigger.type).toBe('cron');
      if (trigger.type === 'cron') {
        const action = trigger.action;
        expect(typeof action).toBe('object');
        if (typeof action === 'object') {
          expect(action.title).toBe('Hourly report');
          expect(action.prompt).toBe('Generate hourly report');
          expect(action.priority).toBe('P1');
        }
      }
    });

    it('normalizes flat prompt string to action object', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'flat-trigger',
            target_team: 'my-team',
            type: 'cron',
            schedule: '0 * * * *',
            prompt: 'Legacy prompt text',
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      const trigger = result.triggers![0]!;
      expect(trigger.type).toBe('cron');
      if (trigger.type === 'cron') {
        const action = trigger.action;
        expect(typeof action).toBe('object');
        if (typeof action === 'object') {
          expect(action.prompt).toBe('Legacy prompt text');
          expect(action.title).toBe('Triggered task');
          expect(action.priority).toBe('P2');
        }
      }
    });

    it('accepts optional agent field with valid AID on cron trigger', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'agent-trigger',
            target_team: 'my-team',
            agent: 'aid-worker-abc',
            type: 'cron',
            schedule: '0 * * * *',
            action: { title: 'Worker job', prompt: 'Run task', priority: 'P0' },
          },
        ],
      };
      expect(() => validateTeam(team)).not.toThrow();
      const result = validateTeam(team);
      const trigger = result.triggers![0]!;
      expect(trigger.agent).toBe('aid-worker-abc');
    });

    it('rejects agent field with invalid AID format', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'bad-agent-trigger',
            target_team: 'my-team',
            agent: 'not-a-valid-aid',
            type: 'cron',
            schedule: '0 * * * *',
            action: { title: 'Job', prompt: 'Run task', priority: 'P0' },
          },
        ],
      };
      expect(() => validateTeam(team)).toThrow();
    });

    it('rejects action with invalid priority value', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'bad-priority-trigger',
            target_team: 'my-team',
            type: 'cron',
            schedule: '0 * * * *',
            action: { title: 'Job', prompt: 'Run task', priority: 'P3' },
          },
        ],
      };
      expect(() => validateTeam(team)).toThrow();
    });

    it('cron trigger without action or prompt fails validation', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        triggers: [
          {
            name: 'no-action-trigger',
            target_team: 'my-team',
            type: 'cron',
            schedule: '0 * * * *',
            // no action, no prompt
          },
        ],
      };
      expect(() => validateTeam(team)).toThrow();
    });
  });

  describe('Schema strictness', () => {
    it('masterConfigSchema rejects unknown fields', () => {
      const config = {
        ...defaultMasterConfig(),
        extra: 'not allowed',
      };
      expect(() => masterConfigSchema.parse(config)).toThrow(ZodError);
    });

    it('providerConfigSchema rejects unknown fields', () => {
      const providers = {
        test: {
          type: 'oauth' as const,
          oauth_token: 'test',
          unknown: 'field',
        },
      };
      expect(() => providerConfigSchema.parse(providers)).toThrow(ZodError);
    });

    it('teamConfigSchema rejects unknown fields', () => {
      const team = {
        slug: 'test-team',
        leader_aid: 'aid-lead-001',
        extra: 'not allowed',
      };
      expect(() => teamConfigSchema.parse(team)).toThrow(ZodError);
    });
  });
});