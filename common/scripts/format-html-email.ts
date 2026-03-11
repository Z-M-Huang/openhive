#!/usr/bin/env bun
/**
 * format-html-email.ts - Markdown subset to inline-styled HTML email converter
 *
 * Converts markdown subset (bold, italic, lists, links, headers, code blocks)
 * to inline-styled HTML suitable for email clients.
 *
 * CLI: bun run format-html-email.ts < input.md > output.html
 *
 * Supported markdown:
 * - # Headers (h1-h3)
 * - **bold**
 * - *italic*
 * - - Lists
 * - [links](url)
 * - `code` (inline)
 * - Fenced code blocks
 */

import { readFileSync } from 'node:fs';

// Inline CSS styles for email (email clients strip <style> blocks)
const STYLES = {
  body: 'font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px;',
  h1: 'font-size: 24px; font-weight: bold; margin: 24px 0 16px; color: #1a1a1a;',
  h2: 'font-size: 20px; font-weight: bold; margin: 20px 0 12px; color: #1a1a1a;',
  h3: 'font-size: 18px; font-weight: bold; margin: 16px 0 10px; color: #1a1a1a;',
  p: 'margin: 0 0 16px;',
  strong: 'font-weight: bold;',
  em: 'font-style: italic;',
  a: 'color: #0066cc; text-decoration: underline;',
  code: 'font-family: "Courier New", Courier, monospace; background-color: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 14px;',
  pre: 'background-color: #f5f5f5; padding: 16px; border-radius: 4px; overflow-x: auto; margin: 16px 0;',
  preCode: 'font-family: "Courier New", Courier, monospace; font-size: 14px;',
  ul: 'margin: 0 0 16px 24px;',
  ol: 'margin: 0 0 16px 24px;',
  li: 'margin: 4px 0;',
};

/**
 * Convert markdown to inline-styled HTML for email
 * @param markdown Input markdown string
 * @returns HTML output
 */
function formatHtmlEmail(markdown: string): string {
  // Security: Strip ALL HTML tags from input first (encode < and > in source text)
  // This prevents XSS and ensures only our controlled HTML is output
  const sanitized = markdown
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = sanitized.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle fenced code blocks
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        const codeContent = codeBlockContent.join('\n');
        const escapedCode = codeContent
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        output.push(`<pre style="${STYLES.pre}"><code style="${STYLES.preCode}">${escapeForHtml(escapedCode)}</code></pre>`);
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        // Start of code block
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    let processedLine = line;

    // Headers
    if (line.startsWith('### ')) {
      processedLine = `<h3 style="${STYLES.h3}">${processInline(line.slice(4))}</h3>`;
    } else if (line.startsWith('## ')) {
      processedLine = `<h2 style="${STYLES.h2}">${processInline(line.slice(3))}</h2>`;
    } else if (line.startsWith('# ')) {
      processedLine = `<h1 style="${STYLES.h1}">${processInline(line.slice(2))}</h1>`;
    }
    // Unordered list
    else if (line.match(/^[-*]\s+/)) {
      processedLine = `<li data-list="ul" style="${STYLES.li}">${processInline(line.slice(2))}</li>`;
    }
    // Ordered list
    else if (line.match(/^\d+\.\s+/)) {
      processedLine = `<li data-list="ol" style="${STYLES.li}">${processInline(line.slice(line.indexOf('.') + 2))}</li>`;
    }
    // Empty line
    else if (line.trim() === '') {
      processedLine = '';
    }
    // Regular paragraph
    else {
      processedLine = `<p style="${STYLES.p}">${processInline(line)}</p>`;
    }

    output.push(processedLine);
  }

  // Wrap list items in ul/ol tags
  const finalOutput = wrapLists(output.join('\n'));

  // Build final HTML with inline styles
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="${STYLES.body}">
${finalOutput}
</body>
</html>`;
}

/**
 * Process inline markdown: bold, italic, code, links
 */
function processInline(text: string): string {
  let result = text;

  // Code (inline) - must be processed first
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    return `<code style="${STYLES.code}">${escapeForHtml(code)}</code>`;
  });

  // Bold: **text** or __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, content) => {
    return `<strong style="${STYLES.strong}">${content}</strong>`;
  });

  // Italic: *text* or _text_
  result = result.replace(/\*([^*]+)\*/g, (_, content) => {
    return `<em style="${STYLES.em}">${content}</em>`;
  });

  // Links: [text](url) - validate URL scheme
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const trimmedUrl = url.trim();
    // Security: Validate link URLs - only http/https schemes allowed
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      // Reject javascript: and other dangerous schemes
      return escapeForHtml(linkText);
    }
    // Block javascript: URLs (case insensitive check)
    if (trimmedUrl.toLowerCase().startsWith('javascript:')) {
      return escapeForHtml(linkText);
    }
    return `<a href="${escapeForHtml(trimmedUrl)}" style="${STYLES.a}">${escapeForHtml(linkText)}</a>`;
  });

  return result;
}

/**
 * Escape HTML entities for safe output
 */
function escapeForHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap adjacent list items in ul/ol tags
 */
function wrapLists(html: string): string {
  const lines = html.split('\n');
  const output: string[] = [];
  let inUl = false;
  let inOl = false;

  for (const line of lines) {
    const isOlItem = line.includes('data-list="ol"');
    const isUlItem = line.includes('data-list="ul"');
    const isLi = isOlItem || isUlItem;

    // Close current list if type changes (ul->ol or ol->ul)
    if (isLi && ((inUl && isOlItem) || (inOl && isUlItem))) {
      if (inUl) { output.push('</ul>'); inUl = false; }
      if (inOl) { output.push('</ol>'); inOl = false; }
    }

    if (isLi && !inUl && !inOl) {
      // Start new list based on data attribute
      if (isOlItem) {
        output.push(`<ol style="${STYLES.ol}">`);
        inOl = true;
      } else {
        output.push(`<ul style="${STYLES.ul}">`);
        inUl = true;
      }
    } else if (!isLi && (inUl || inOl)) {
      // Close list
      if (inUl) { output.push('</ul>'); inUl = false; }
      if (inOl) { output.push('</ol>'); inOl = false; }
    }

    // Strip data-list attribute from output
    output.push(line.replace(/ data-list="(?:ul|ol)"/, ''));
  }

  // Close any open list at end
  if (inUl) output.push('</ul>');
  if (inOl) output.push('</ol>');

  return output.join('\n');
}

// CLI execution
function main() {
  try {
    // Read from stdin
    const input = readFileSync('/dev/stdin', 'utf-8');

    if (!input.trim()) {
      console.error('Usage: bun run format-html-email.ts < input.md > output.html');
      process.exit(1);
    }

    const html = formatHtmlEmail(input);
    process.stdout.write(html);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();