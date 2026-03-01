/**
 * OpenHive Agent Runner - Entry point
 *
 * Container orchestrator for managing Claude Agent SDK instances.
 * Modes:
 *   --mode=master  Spawned as child process in master container
 *   --mode=team    Runs in team container, connects via Docker network
 */

function main(): void {
  console.log('OpenHive Agent Runner starting...');

  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'master';

  console.log(`Mode: ${mode}`);
}

main();
