/**
 * Agent entry point for Claude Agent SDK processes.
 *
 * This is the main entry point for agent processes spawned by AgentExecutor.
 * It reads configuration from environment variables and spawns the SDK CLI.
 *
 * Environment variables:
 * - OPENHIVE_AGENT_AID: Agent ID
 * - OPENHIVE_AGENT_NAME: Agent name
 * - OPENHIVE_AGENT_MODEL: Model to use (e.g., claude-sonnet-4-20250514)
 * - CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY: Provider credentials
 * - OPENHIVE_AGENT_TOOLS: JSON array of allowed tools (optional)
 * - OPENHIVE_AGENT_SYSTEM_PROMPT: System prompt (optional)
 *
 * @module agent-entry
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
  aid: string;
  name: string;
  model: string;
  tools: string[];
  systemPrompt?: string;
  workspacePath: string;
}

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

function loadConfig(): AgentConfig {
  const aid = process.env.OPENHIVE_AGENT_AID;
  const name = process.env.OPENHIVE_AGENT_NAME;
  const model = process.env.OPENHIVE_AGENT_MODEL;

  if (!aid || !name || !model) {
    throw new Error('Missing required agent environment variables: OPENHIVE_AGENT_AID, OPENHIVE_AGENT_NAME, OPENHIVE_AGENT_MODEL');
  }

  const toolsJson = process.env.OPENHIVE_AGENT_TOOLS;
  const tools = toolsJson ? JSON.parse(toolsJson) : [];

  return {
    aid,
    name,
    model,
    tools,
    systemPrompt: process.env.OPENHIVE_AGENT_SYSTEM_PROMPT,
    workspacePath: process.cwd(),
  };
}

function loadSystemPrompt(config: AgentConfig): string {
  // Try workspace-specific CLAUDE.md first
  const claudeMdPath = path.join(config.workspacePath, '.claude', 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    return fs.readFileSync(claudeMdPath, 'utf-8');
  }

  // Fall back to env var or default
  return config.systemPrompt || `You are ${config.name}, an AI agent in the OpenHive system.`;
}

function loadSkills(config: AgentConfig): string[] {
  const skillsDir = path.join(config.workspacePath, '.claude', 'skills');
  const skills: string[] = [];

  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          skills.push(skillPath);
        }
      }
    }
  }

  // Also check common skills
  const commonSkillsDir = '/app/common/skills';
  if (fs.existsSync(commonSkillsDir)) {
    const entries = fs.readdirSync(commonSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(commonSkillsDir, entry.name, 'SKILL.md');
        // Don't add if already shadowed by workspace skill
        if (fs.existsSync(skillPath) && !skills.some(s => s.endsWith(`${entry.name}/SKILL.md`))) {
          skills.push(skillPath);
        }
      }
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const systemPrompt = loadSystemPrompt(config);
  const skillPaths = loadSkills(config);

  console.log(`Agent ${config.aid} starting with model ${config.model}`);
  console.log(`Workspace: ${config.workspacePath}`);
  console.log(`Skills: ${skillPaths.length} loaded`);

  // Path to SDK CLI
  const sdkCliPath = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');

  // Build CLI arguments
  const cliArgs: string[] = [
    '--model', config.model,
    '--permission-mode', 'bypassPermissions',
    '--settings-sources', 'project',
  ];

  // Add print mode for non-interactive operation
  cliArgs.push('--print');

  // Spawn the SDK CLI
  const child = spawn('node', [sdkCliPath, ...cliArgs], {
    cwd: config.workspacePath,
    env: {
      ...process.env,
      // Pass system prompt via environment
      CLAUDE_SYSTEM_PROMPT: systemPrompt,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  console.log(`SDK CLI spawned with PID ${child.pid}`);

  // Forward stdout
  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(data);
  });

  // Forward stderr
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data);
  });

  // Handle SDK CLI exit
  child.on('exit', (code, signal) => {
    console.log(`SDK CLI exited with code ${code}, signal ${signal}`);
    process.exit(code ?? 1);
  });

  // Handle shutdown signals - forward to child
  process.on('SIGTERM', () => {
    console.log(`Agent ${config.aid} received SIGTERM, forwarding to SDK`);
    child.kill('SIGTERM');
  });

  process.on('SIGINT', () => {
    console.log(`Agent ${config.aid} received SIGINT, forwarding to SDK`);
    child.kill('SIGINT');
  });

  // Keep the process alive until child exits
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
}

main().catch((err) => {
  console.error('Agent entry error:', err);
  process.exit(1);
});