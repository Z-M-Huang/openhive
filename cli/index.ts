/**
 * Standalone CLI client for OpenHive.
 *
 * Connects to the server via WebSocket at /ws/cli and provides a minimal
 * terminal interface for sending messages and displaying responses.
 *
 * Usage: bun run cli/index.ts
 *
 * Environment:
 *   OPENHIVE_URL — WebSocket server URL (default: ws://localhost:8080/ws/cli)
 */

import * as readline from 'node:readline';

const url = process.env.OPENHIVE_URL ?? 'ws://localhost:8080/ws/cli';
const responseTimeoutMs = 300_000; // 5 min max wait for piped mode

let rl: readline.Interface | null = null;
let waitingForResponse = false;

function cleanup(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function fatal(message: string): never {
  console.error(message);
  cleanup();
  process.exit(1);
}

// --- WebSocket connection ---

let ws: WebSocket;
try {
  ws = new WebSocket(url);
} catch (err) {
  fatal(`Failed to create WebSocket connection to ${url}: ${err}`);
}

ws.addEventListener('open', () => {
  console.log(`Connected to ${url}\n`);

  // Start readline interface
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'openhive> ',
  });

  rl.prompt();

  rl.on('line', (line: string) => {
    const trimmed = line.trim();

    if (trimmed === 'exit') {
      console.log('Goodbye.');
      ws.close();
      cleanup();
      process.exit(0);
    }

    if (trimmed.length === 0) {
      rl?.prompt();
      return;
    }

    const message = JSON.stringify({
      type: 'message',
      content: trimmed,
    });

    ws.send(message);
  });

  rl.on('close', () => {
    // Ctrl+C or EOF from piped input
    // If stdin is a TTY (interactive), exit immediately.
    // If stdin is piped, wait for any pending response before exiting.
    if (process.stdin.isTTY) {
      console.log('\nGoodbye.');
      ws.close();
      process.exit(0);
    }
    // Piped mode: set a flag so the message handler can exit after receiving a response.
    // Also set a timeout so we don't hang forever if no response comes.
    waitingForResponse = true;
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, responseTimeoutMs);
  });
});

ws.addEventListener('message', (event: MessageEvent) => {
  try {
    const data = JSON.parse(String(event.data));

    if (data.type === 'response' && typeof data.content === 'string') {
      // Clear prompt line, print response, re-display prompt
      process.stdout.write('\r\x1b[K');
      console.log(`[Assistant] ${data.content}\n`);
      if (waitingForResponse) {
        // Piped mode: we got the response, exit cleanly
        ws.close();
        process.exit(0);
      }
      rl?.prompt();
    } else if (data.type === 'connected') {
      // Server acknowledged connection — no action needed
    }
  } catch {
    // Ignore malformed messages
  }
});

ws.addEventListener('error', (event: Event) => {
  const message = 'message' in event ? String((event as ErrorEvent).message) : 'unknown error';
  fatal(`WebSocket error: ${message}`);
});

ws.addEventListener('close', (event: CloseEvent) => {
  if (event.code === 1000) {
    // Normal close — already handled
    return;
  }
  cleanup();
  console.error(`\nConnection closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
  process.exit(1);
});
