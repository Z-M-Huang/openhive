import { describe, it, expect, vi } from 'vitest';
import { buildBrowserToolDefs, type BrowserToolDeps } from './browser-tools.js';
import type { BrowserRelay } from './browser-proxy.js';
import type { TeamConfig } from '../domain/types.js';

function mockRelay(overrides?: Partial<BrowserRelay>): BrowserRelay {
  return {
    available: true,
    getToolNames: () => ['browser_navigate', 'browser_snapshot'],
    callTool: vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockDeps(overrides?: {
  teamConfig?: TeamConfig | undefined;
  relay?: BrowserRelay;
}): BrowserToolDeps {
  const relay = overrides?.relay ?? mockRelay();
  return {
    browserRelay: relay,
    getTeamConfig: vi.fn().mockReturnValue(overrides?.teamConfig),
  };
}

const TEAM_WITH_BROWSER: TeamConfig = {
  name: 'browser-team',
  parent: null,
  description: 'test',
  allowed_tools: [],
  mcp_servers: [],
  provider_profile: 'default',
  maxTurns: 50,
  browser: {},
};

const TEAM_WITH_DOMAINS: TeamConfig = {
  ...TEAM_WITH_BROWSER,
  browser: { allowed_domains: ['example.com', '*.internal.io'] },
};

const TEAM_WITHOUT_BROWSER: TeamConfig = {
  name: 'no-browser-team',
  parent: null,
  description: 'test',
  allowed_tools: [],
  mcp_servers: [],
  provider_profile: 'default',
  maxTurns: 50,
};

describe('Browser Tools: buildBrowserToolDefs', () => {
  it('returns 8 browser tools', () => {
    const deps = mockDeps({ teamConfig: TEAM_WITH_BROWSER });
    const tools = buildBrowserToolDefs(deps);
    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_screenshot');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_type');
    expect(names).toContain('browser_go_back');
    expect(names).toContain('browser_go_forward');
    expect(names).toContain('browser_close');
  });

  it('denies team without browser: config (Gate 1)', async () => {
    const deps = mockDeps({ teamConfig: TEAM_WITHOUT_BROWSER });
    const tools = buildBrowserToolDefs(deps);
    const navigate = tools.find((t) => t.name === 'browser_navigate')!;

    const result = await navigate.handler({ url: 'https://example.com' }, 'team-1');
    expect(result).toEqual({ success: false, error: 'browser tools not enabled for this team' });
  });

  it('denies when getTeamConfig returns undefined', async () => {
    const deps = mockDeps({ teamConfig: undefined });
    const tools = buildBrowserToolDefs(deps);
    const snapshot = tools.find((t) => t.name === 'browser_snapshot')!;

    const result = await snapshot.handler({}, 'unknown-team');
    expect(result).toEqual({ success: false, error: 'browser tools not enabled for this team' });
  });

  it('forwards browser_navigate with allowed domain', async () => {
    const relay = mockRelay();
    const deps = mockDeps({ teamConfig: TEAM_WITH_DOMAINS, relay });
    const tools = buildBrowserToolDefs(deps);
    const navigate = tools.find((t) => t.name === 'browser_navigate')!;

    await navigate.handler({ url: 'https://example.com/page' }, 'team-1');
    expect(relay.callTool).toHaveBeenCalledWith('browser_navigate', { url: 'https://example.com/page' });
  });

  it('blocks browser_navigate with disallowed domain', async () => {
    const deps = mockDeps({ teamConfig: TEAM_WITH_DOMAINS });
    const tools = buildBrowserToolDefs(deps);
    const navigate = tools.find((t) => t.name === 'browser_navigate')!;

    const result = await navigate.handler({ url: 'https://evil.com' }, 'team-1');
    expect(result).toEqual({ success: false, error: expect.stringContaining('evil.com') });
  });

  it('allows all URLs when no allowed_domains configured', async () => {
    const relay = mockRelay();
    const deps = mockDeps({ teamConfig: TEAM_WITH_BROWSER, relay });
    const tools = buildBrowserToolDefs(deps);
    const navigate = tools.find((t) => t.name === 'browser_navigate')!;

    await navigate.handler({ url: 'https://anything.com' }, 'team-1');
    expect(relay.callTool).toHaveBeenCalledWith('browser_navigate', { url: 'https://anything.com' });
  });

  it('forwards browser_snapshot correctly', async () => {
    const relay = mockRelay();
    const deps = mockDeps({ teamConfig: TEAM_WITH_BROWSER, relay });
    const tools = buildBrowserToolDefs(deps);
    const snapshot = tools.find((t) => t.name === 'browser_snapshot')!;

    const result = await snapshot.handler({}, 'team-1');
    expect(relay.callTool).toHaveBeenCalledWith('browser_snapshot', {});
    expect(result).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('forwards correct tool name and args to relay', async () => {
    const relay = mockRelay();
    const deps = mockDeps({ teamConfig: TEAM_WITH_BROWSER, relay });
    const tools = buildBrowserToolDefs(deps);
    const type = tools.find((t) => t.name === 'browser_type')!;

    await type.handler({ ref: 'input-1', text: 'hello' }, 'team-1');
    expect(relay.callTool).toHaveBeenCalledWith('browser_type', { ref: 'input-1', text: 'hello' });
  });
});
