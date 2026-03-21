/**
 * Skill and web browsing tool handlers.
 *
 * @module mcp/tools/handlers-skill
 */

import crypto from 'node:crypto';
import { SearchSkillSchema, InstallSkillSchema, BrowseWebSchema } from './schemas.js';
import { assertNotPrivateUrl } from './helpers.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createSkillHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('search_skill', async (args) => {
    const parsed = SearchSkillSchema.parse(args);

    if (parsed.registry) {
      const allowed = ctx.skillRegistries ?? [];
      if (!allowed.includes(parsed.registry)) {
        throw new Error(
          `Registry '${parsed.registry}' is not in the configured skill_registries allowlist. ` +
          `Allowed: ${allowed.join(', ') || '(none configured)'}`
        );
      }
    }

    const registries = parsed.registry
      ? [parsed.registry]
      : (ctx.skillRegistries ?? []);

    if (registries.length === 0) {
      return { results: [], message: 'No skill registries configured. Add skill_registries to openhive.yaml.' };
    }

    const results: Array<{ name: string; description: string; registry_url: string; version?: string }> = [];
    for (const registryUrl of registries) {
      try {
        const url = `${registryUrl.replace(/\/$/, '')}/api/search?q=${encodeURIComponent(parsed.query)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const data = await response.json() as { skills?: Array<{ name: string; description: string; version?: string }> };
          if (data.skills) {
            for (const skill of data.skills) {
              results.push({ ...skill, registry_url: registryUrl });
            }
          }
        }
      } catch {
        // Registry unreachable — skip silently, return partial results
      }
    }
    return { results, registries_searched: registries.length };
  });

  handlers.set('install_skill', async (args, _agentAid, teamSlug) => {
    const parsed = InstallSkillSchema.parse(args);

    const allowedRegistries = ctx.skillRegistries ?? [];
    if (!allowedRegistries.includes(parsed.registry_url)) {
      throw new Error(
        `Registry '${parsed.registry_url}' is not in the configured skill_registries allowlist. ` +
        `Allowed: ${allowedRegistries.join(', ') || '(none configured)'}`
      );
    }

    const url = `${parsed.registry_url.replace(/\/$/, '')}/api/skills/${encodeURIComponent(parsed.name)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch skill '${parsed.name}' from ${parsed.registry_url}: HTTP ${response.status}`);
    }

    const data = await response.json() as { content: string; name: string; description?: string };
    if (!data.content) {
      throw new Error(`Skill '${parsed.name}' has no content`);
    }

    if (!data.content.startsWith('---')) {
      throw new Error(`Skill '${parsed.name}' is missing YAML frontmatter`);
    }

    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const team = ctx.orgChart.getTeamBySlug(teamSlug);
    const workspacePath = team?.workspacePath ?? '/app/workspace';
    const skillDir = join(workspacePath, '.claude', 'skills', parsed.name);

    await mkdirFs(skillDir, { recursive: true });
    await writeFileFs(join(skillDir, 'SKILL.md'), data.content, 'utf-8');

    ctx.logger.info('Skill installed from registry', {
      name: parsed.name,
      registry: parsed.registry_url,
      team_slug: teamSlug,
      path: join(skillDir, 'SKILL.md'),
    });

    return {
      installed_path: join(skillDir, 'SKILL.md'),
      name: parsed.name,
      description: data.description ?? '',
    };
  });

  // ---- Web browsing tool (1) ----

  // Lazy singleton browser — one Chromium per root process, fresh context per call
  let browserInstance: import('playwright').Browser | null = null;

  handlers.set('browse_web', async (args) => {
    const parsed = BrowseWebSchema.parse(args);
    assertNotPrivateUrl(parsed.url);

    const { chromium } = await import('playwright');

    if (!browserInstance || !browserInstance.isConnected()) {
      browserInstance = await chromium.launch({ headless: true });
    }

    const context = await browserInstance.newContext();
    const page = await context.newPage();

    try {
      await page.route('**/*', async (route) => {
        try {
          assertNotPrivateUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });

      await page.goto(parsed.url, {
        waitUntil: 'networkidle',
        timeout: parsed.timeout_ms ?? 30_000,
      });

      switch (parsed.action) {
        case 'fetch': {
          if (parsed.wait_for) {
            await page.waitForSelector(parsed.wait_for, { timeout: 5000 }).catch(() => {});
          }
          const content = parsed.extract_text !== false
            ? await page.innerText('body')
            : await page.content();
          const truncated = content.length > 50000 ? content.slice(0, 50000) + '...(truncated)' : content;
          return { url: parsed.url, title: await page.title(), content: truncated };
        }

        case 'screenshot': {
          const { mkdir: mkFs } = await import('node:fs/promises');
          const { join } = await import('node:path');
          const screenshotDir = join('/app/workspace', 'screenshots');
          await mkFs(screenshotDir, { recursive: true });
          const filename = `${crypto.randomUUID()}.png`;
          const filepath = join(screenshotDir, filename);
          await page.screenshot({ fullPage: true, path: filepath });
          return { url: parsed.url, title: await page.title(), screenshot_path: filepath };
        }

        case 'click': {
          if (parsed.fill) {
            for (const [sel, val] of Object.entries(parsed.fill)) {
              await page.fill(sel, val);
            }
          }
          if (parsed.selector) await page.click(parsed.selector);
          if (parsed.submit_selector) await page.click(parsed.submit_selector);
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          const clickContent = await page.innerText('body');
          return {
            url: page.url(),
            title: await page.title(),
            content: clickContent.length > 50000 ? clickContent.slice(0, 50000) + '...(truncated)' : clickContent,
          };
        }

        case 'extract_links': {
          const links = await page.locator('a[href]').evaluateAll(els =>
            els.map(a => ({ text: a.textContent?.trim() ?? '', href: (a as HTMLAnchorElement).href }))
              .filter(l => l.href.startsWith('http'))
          );
          return { url: parsed.url, title: await page.title(), links: links.slice(0, 200) };
        }

        default:
          throw new Error(`Unknown browse_web action`);
      }
    } finally {
      await page.close();
      await context.close();
    }
  });

  return handlers;
}
