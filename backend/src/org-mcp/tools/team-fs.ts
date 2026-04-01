import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function cleanupTeamDirs(runDir: string, teamName: string): void {
  const teamDir = join(runDir, 'teams', teamName);
  if (existsSync(teamDir)) {
    rmSync(teamDir, { recursive: true, force: true });
  }
}
