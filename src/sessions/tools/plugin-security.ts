/**
 * Static analysis scanner for plugin tool source code.
 *
 * Detects forbidden runtime patterns (eval, child_process, process.env)
 * and common secret formats (AWS keys, OpenAI keys, GitHub PATs, etc.).
 */

export interface SecurityScanResult {
  forbiddenPatterns: string[];
  detectedSecrets: string[];
  passed: boolean;
}

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /child_process/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
  /\bBun\.spawn\b/,
  /\bprocess\.env\b/,
  /\brequire\s*\(\s*['"]child_process/,
];

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,           // AWS access key
  /\bsk-[a-zA-Z0-9]{20,}/,      // OpenAI/Stripe key
  /\bghp_[a-zA-Z0-9]{36,}/,     // GitHub PAT
  /\bglpat-[a-zA-Z0-9\-_]{20,}/, // GitLab PAT
];

export function scanPluginSource(source: string): SecurityScanResult {
  const forbiddenPatterns: string[] = [];
  const detectedSecrets: string[] = [];

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) forbiddenPatterns.push(pattern.source);
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(source)) detectedSecrets.push(pattern.source);
  }

  return {
    forbiddenPatterns,
    detectedSecrets,
    passed: forbiddenPatterns.length === 0 && detectedSecrets.length === 0,
  };
}
