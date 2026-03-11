#!/usr/bin/env bun
/**
 * render-template.ts - Minimal Mustache template renderer
 *
 * Supports {{var}} substitution with HTML escaping.
 * Use {{{var}}} for raw (unescaped) output.
 *
 * CLI: bun run render-template.ts --template <path> --data <json_path_or_string> [--raw]
 */

import { readFileSync, readFile } from 'node:fs';
import { parseArgs } from 'node:util';

// Security limits
const MAX_TEMPLATE_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_VARIABLE_COUNT = 1000;

/**
 * HTML-escape a string for safe output in HTML contexts
 */
function htmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a Mustache template with variable substitution
 * @param template Template string with {{var}} and {{{var}}} placeholders
 * @param data Object containing variable values
 * @param raw If true, don't HTML-escape any output
 * @returns Rendered string
 */
function renderTemplate(template: string, data: Record<string, unknown>, raw = false): string {
  // Security: Check template size
  if (template.length > MAX_TEMPLATE_SIZE) {
    throw new Error(`Template exceeds maximum size of ${MAX_TEMPLATE_SIZE} bytes`);
  }

  let variableCount = 0;
  const result = template.replace(/\{\{\{(.+?)\}\}\}|\{\{(.+?)\}\}/g, (match, rawVar, escapedVar) => {
    const varName = rawVar ?? escapedVar;
    const isRaw = rawVar !== undefined;

    variableCount++;
    if (variableCount > MAX_VARIABLE_COUNT) {
      throw new Error(`Template exceeds maximum variable count of ${MAX_VARIABLE_COUNT}`);
    }

    // Security: No dynamic code execution - just use the var name as string
    const trimmedName = varName.trim();
    if (!trimmedName.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
      throw new Error(`Invalid variable name: ${trimmedName}`);
    }

    const value = data[trimmedName];

    if (value === undefined || value === null) {
      return '';
    }

    const stringValue = String(value);

    if (raw || isRaw) {
      return stringValue;
    }

    return htmlEscape(stringValue);
  });

  return result;
}

/**
 * Load JSON data from a file path or parse directly
 */
function loadData(dataArg: string): Record<string, unknown> {
  // Try to read as file path first
  try {
    const content = readFileSync(dataArg, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Not a valid file path, try parsing as JSON string
    return JSON.parse(dataArg);
  }
}

/**
 * Load template from file
 */
function loadTemplate(templatePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    readFile(templatePath, 'utf-8', (err, content) => {
      if (err) {
        reject(new Error(`Failed to read template: ${err.message}`));
        return;
      }
      resolve(content);
    });
  });
}

// CLI execution
async function main() {
  try {
    const { values } = parseArgs({
      options: {
        template: {
          type: 'string',
          short: 't',
        },
        data: {
          type: 'string',
          short: 'd',
        },
        raw: {
          type: 'boolean',
          short: 'r',
          default: false,
        },
        help: {
          type: 'boolean',
          short: 'h',
          default: false,
        },
      },
      allowPositionals: false,
    });

    if (values.help || !values.template || !values.data) {
      console.error(`Usage: bun run render-template.ts --template <path> --data <json_path_or_string> [--raw]`);
      console.error(`       bun run render-template.ts -t template.tmpl -d '{"name": "value"}'`);
      console.error(`       bun run render-template.ts -t template.tmpl -d data.json`);
      process.exit(values.help ? 0 : 1);
    }

    const template = await loadTemplate(values.template!);
    const data = loadData(values.data!);

    const output = renderTemplate(template, data, values.raw ?? false);
    process.stdout.write(output);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export { renderTemplate, htmlEscape };

main();