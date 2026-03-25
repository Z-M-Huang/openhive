/**
 * Team registry — tracks active team sessions with idle timeout.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface SessionInfo {
  readonly abortController: AbortController;
  readonly startedAt: Date;
  readonly idleTimer: ReturnType<typeof setTimeout>;
}

export interface SessionStatus {
  readonly active: boolean;
  readonly uptimeMs: number;
}

export interface TeamRegistryOpts {
  readonly idleTimeoutMs?: number;
}

export class TeamRegistry {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly idleTimeoutMs: number;

  constructor(opts?: TeamRegistryOpts) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Register a new active session for a team.
   * If a session already exists for this team, it is stopped first.
   */
  spawn(teamName: string): AbortController {
    if (this.sessions.has(teamName)) {
      this.stop(teamName);
    }

    const abortController = new AbortController();
    const startedAt = new Date();
    const idleTimer = setTimeout(() => { this.stop(teamName); }, this.idleTimeoutMs);

    this.sessions.set(teamName, { abortController, startedAt, idleTimer });
    return abortController;
  }

  /** Stop a session and clean up its resources. */
  stop(teamName: string): void {
    const session = this.sessions.get(teamName);
    if (!session) return;

    clearTimeout(session.idleTimer);
    session.abortController.abort();
    this.sessions.delete(teamName);
  }

  /** Reset the idle timeout for an active session. */
  touch(teamName: string): void {
    const session = this.sessions.get(teamName);
    if (!session) return;

    clearTimeout(session.idleTimer);
    const newTimer = setTimeout(() => { this.stop(teamName); }, this.idleTimeoutMs);

    // Rebuild entry with new timer
    this.sessions.set(teamName, {
      abortController: session.abortController,
      startedAt: session.startedAt,
      idleTimer: newTimer,
    });
  }

  /** List all active team names. */
  getActive(): string[] {
    return [...this.sessions.keys()];
  }

  /** Check if a team has an active session. */
  isActive(teamName: string): boolean {
    return this.sessions.has(teamName);
  }

  /** Get status for a team session. */
  getStatus(teamName: string): SessionStatus {
    const session = this.sessions.get(teamName);
    if (!session) {
      return { active: false, uptimeMs: 0 };
    }
    return {
      active: true,
      uptimeMs: Date.now() - session.startedAt.getTime(),
    };
  }

  /** Stop all sessions (for shutdown). */
  stopAll(): void {
    for (const teamName of [...this.sessions.keys()]) {
      this.stop(teamName);
    }
  }
}
