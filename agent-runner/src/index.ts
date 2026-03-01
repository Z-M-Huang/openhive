/**
 * OpenHive Agent Runner - Entry point
 *
 * Container orchestrator for managing Claude Agent SDK instances.
 * Modes:
 *   --mode=master  Spawned as child process in master container
 *   --mode=team    Runs in team container, connects via Docker network
 */

import { WSClient } from './ws-client.js';
import { Orchestrator } from './orchestrator.js';

interface CLIArgs {
  mode: 'master' | 'team';
  wsUrl: string;
  teamId: string;
  token: string;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const get = (prefix: string, defaultVal: string): string => {
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.split('=')[1] : defaultVal;
  };

  const mode = get('--mode=', 'master') as 'master' | 'team';
  const teamId = get('--team=', 'main');
  const token = get('--token=', process.env.WS_TOKEN ?? '');

  // Default WS URL: prefer WS_URL env var (set by Go parent), else compute from mode
  const envWsUrl = process.env.WS_URL ?? '';
  const defaultWsUrl =
    envWsUrl !== ''
      ? envWsUrl
      : mode === 'master'
        ? `ws://localhost:8080/ws/container?token=${token}`
        : `ws://openhive:8080/ws/container?token=${token}`;

  const wsUrl = get('--ws-url=', defaultWsUrl);

  return { mode, wsUrl, teamId, token };
}

function main(): void {
  const cliArgs = parseArgs();
  console.log(`OpenHive Agent Runner starting (mode=${cliArgs.mode}, team=${cliArgs.teamId})`);

  // WSClient and Orchestrator reference each other:
  // WSClient routes messages to Orchestrator, Orchestrator sends via WSClient.
  // We break the circular dependency by using a deferred reference object that
  // the closures capture, then assigning the real orchestrator after both are created.
  const ref: { orchestrator: Orchestrator | null } = { orchestrator: null };

  const wsClient = new WSClient({
    url: cliArgs.wsUrl,
    onMessage: (msg) => ref.orchestrator!.handleMessage(msg),
    onConnect: () => console.log('Connected to Go backend'),
    onDisconnect: () => {
      console.log('Disconnected from Go backend');
      ref.orchestrator!.onDisconnect();
    },
  });

  const orchestrator = new Orchestrator(wsClient);
  ref.orchestrator = orchestrator;
  orchestrator.setTeamId(cliArgs.teamId);

  wsClient.connect();

  // Handle process signals
  const shutdown = (): void => {
    console.log('Shutting down...');
    wsClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
