/**
 * Prompt capture helpers for UAT scenarios.
 *
 * Provides utilities for capturing assembled prompts during message handling.
 */

/**
 * Captured prompt and progress data.
 */
export interface CapturedPrompt {
  /** The assembled system prompt */
  prompt: string;
  /** Progress messages logged during execution */
  progress: string[];
}

/**
 * Options for capturing prompts.
 */
export interface CapturePromptOptions {
  /** Team to send message to */
  team?: string;
  /** Message content */
  message?: string;
  /** Active skill (optional) */
  skill?: string;
  /** Subagent (optional) */
  subagent?: string;
}

/**
 * Capture the assembled prompt from a session run.
 * 
 * This is a stub implementation that returns placeholder data.
 * Tests should skip until real capture is implemented.
 */
export function capturePrompt(_runSessionFn?: () => Promise<unknown>, _opts?: CapturePromptOptions): CapturedPrompt {
  // Stub implementation - returns empty placeholder
  // Real implementation would intercept prompt assembly
  return {
    prompt: '',
    progress: [],
  };
}

/**
 * Check if a prompt contains MCP terminology.
 */
export function containsMcpTerminology(prompt: string): boolean {
  const mcpPatterns = [
    'MCP',
    'mcp_server',
    'mcpServers',
    'Model Context Protocol',
    'mcp__',
  ];
  
  return mcpPatterns.some(pattern => prompt.includes(pattern));
}

/**
 * Check if a prompt contains credential information.
 */
export function containsCredentialInfo(prompt: string): boolean {
  const credentialPatterns = [
    'Available Credentials',
    'credential:',
    'credentials:',
    'API_KEY',
    'SECRET',
    'TOKEN',
  ];
  
  return credentialPatterns.some(pattern => prompt.includes(pattern));
}

/**
 * Check if a prompt contains skill content.
 */
export function containsSkillContent(prompt: string, skillName?: string): boolean {
  if (!skillName) {
    // Check for any skill content
    return prompt.includes('SKILL') || prompt.includes('skill:');
  }
  return prompt.includes(skillName);
}

/**
 * Extract sections from a prompt.
 */
export function extractPromptSections(prompt: string): Record<string, string> {
  const sections: Record<string, string> = {};
  
  // Match markdown-style headers
  const sectionRegex = /^##+ (.+)$/gm;
  let match;
  let lastSection = '';
  let lastIndex = 0;
  
  while ((match = sectionRegex.exec(prompt)) !== null) {
    if (lastSection) {
      sections[lastSection] = prompt.slice(lastIndex, match.index).trim();
    }
    lastSection = match[1];
    lastIndex = match.index + match[0].length;
  }
  
  if (lastSection) {
    sections[lastSection] = prompt.slice(lastIndex).trim();
  }
  
  return sections;
}