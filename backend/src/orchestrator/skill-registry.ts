/**
 * OpenHive Backend - SkillRegistry Implementation
 *
 * Loads skills from external registries or direct URLs. install() downloads a
 * skill and copies it into the team's workspace. search() queries configured
 * registries for available skills. Skills are Markdown files with YAML
 * frontmatter — no executable code.
 *
 * Each installation creates a team-local copy — skills are never shared live
 * references between teams. See Architecture Decisions #75.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillRegistry } from '../domain/interfaces.js';
import type { SkillInfo } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import { validateSkillName } from './skills.js';

// ---------------------------------------------------------------------------
// SkillRegistryDeps
// ---------------------------------------------------------------------------

export interface SkillRegistryDeps {
  /** Configured registry URLs (e.g. ["https://clawhub.ai/skills"]). */
  registryUrls: string[];
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
  /** Optional fetch function for testing (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// SkillRegistryImpl
// ---------------------------------------------------------------------------

export class SkillRegistryImpl implements SkillRegistry {
  private readonly registryUrls: string[];
  private readonly logger: SkillRegistryDeps['logger'];
  private readonly fetchFn: typeof fetch;

  constructor(deps: SkillRegistryDeps) {
    this.registryUrls = [...deps.registryUrls];
    this.logger = deps.logger;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
  }

  /**
   * Validates a URL for SSRF protection:
   * - Must use https: scheme
   * - Must not target private/link-local IP ranges
   */
  private validateFetchUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError('url', `invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new ValidationError('url', 'only https URLs are allowed for skill installation');
    }
    // Block obvious private/link-local hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.') ||
      hostname === '0.0.0.0'
    ) {
      throw new ValidationError('url', 'private/link-local URLs are not allowed');
    }
  }

  /**
   * Install a skill from a registry or direct URL into a team workspace.
   *
   * @param params.name - Skill name to look up in a registry.
   * @param params.registryUrl - Registry URL to fetch from (defaults to first configured).
   * @param params.url - Direct URL to a SKILL.md file (bypasses registry lookup).
   * @param workspacePath - Team workspace root directory.
   * @returns The installed skill name.
   */
  async install(
    params: { name?: string; registryUrl?: string; url?: string },
    workspacePath: string,
  ): Promise<string> {
    let skillContent: string;
    let skillName: string;

    if (params.url !== undefined && params.url !== '') {
      // Direct URL — fetch the SKILL.md file
      this.validateFetchUrl(params.url);
      const response = await this.fetchFn(params.url);
      if (!response.ok) {
        throw new ValidationError('url', `failed to fetch skill from URL: ${response.status} ${response.statusText}`);
      }
      skillContent = await response.text();
      skillName = this.extractSkillName(skillContent, params.name);
    } else if (params.name !== undefined && params.name !== '') {
      // Registry lookup
      const registryUrl = params.registryUrl ?? this.registryUrls[0];
      if (registryUrl === undefined) {
        throw new ValidationError('registryUrl', 'no registry URL configured or provided');
      }
      // Restrict registry URL overrides to configured allowlist
      if (params.registryUrl !== undefined && !this.registryUrls.includes(params.registryUrl)) {
        throw new ValidationError('registryUrl', 'registry URL override must be one of the configured registries');
      }

      // Fetch skill from registry: GET <registry>/<name>/SKILL.md
      const url = `${registryUrl}/${encodeURIComponent(params.name)}/SKILL.md`;
      this.validateFetchUrl(url);
      const response = await this.fetchFn(url);
      if (!response.ok) {
        throw new ValidationError('name', `skill "${params.name}" not found in registry: ${response.status}`);
      }
      skillContent = await response.text();
      // Verify frontmatter name matches requested name (supply chain protection)
      try {
        const frontmatterName = this.extractSkillName(skillContent, undefined);
        if (frontmatterName !== params.name) {
          this.logger.warn('skill frontmatter name mismatch', {
            requested: params.name,
            frontmatter: frontmatterName,
          });
        }
      } catch {
        // No name in frontmatter — acceptable, we use the requested name
      }
      skillName = params.name;
    } else {
      throw new ValidationError('name', 'either name or url must be provided');
    }

    // Validate skill name before writing
    validateSkillName(skillName);

    // Write to workspace: <workspace>/.claude/skills/<name>/SKILL.md
    const skillDir = join(workspacePath, '.claude', 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

    this.logger.info('skill installed', {
      skill_name: skillName,
      workspace_path: workspacePath,
    });

    return skillName;
  }

  /**
   * Search available skills across configured registries.
   * Queries each registry with the given query string.
   */
  async search(query: string): Promise<SkillInfo[]> {
    const results: SkillInfo[] = [];

    for (const registryUrl of this.registryUrls) {
      try {
        const url = `${registryUrl}/search?q=${encodeURIComponent(query)}`;
        const response = await this.fetchFn(url);
        if (!response.ok) continue;

        const data = await response.json() as { skills?: SkillInfo[] };
        if (Array.isArray(data.skills)) {
          for (const skill of data.skills) {
            results.push({
              name: String(skill.name ?? ''),
              description: String(skill.description ?? ''),
              registry_url: registryUrl,
              source_url: String(skill.source_url ?? ''),
            });
          }
        }
      } catch (err) {
        this.logger.warn('skill registry search failed', {
          registry_url: registryUrl,
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * List configured registry URLs.
   */
  listRegistries(): string[] {
    return [...this.registryUrls];
  }

  /**
   * Extracts the skill name from SKILL.md YAML frontmatter.
   * Falls back to the provided name parameter if parsing fails.
   */
  private extractSkillName(content: string, fallbackName?: string): string {
    // Look for name: in YAML frontmatter (between --- delimiters)
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch !== null) {
      const nameMatch = fmMatch[1]!.match(/^name:\s*["']?([^\n"']+)["']?\s*$/m);
      if (nameMatch !== null) {
        return nameMatch[1]!.trim();
      }
    }
    if (fallbackName !== undefined && fallbackName !== '') {
      return fallbackName;
    }
    throw new ValidationError('name', 'could not determine skill name from content or parameters');
  }
}
