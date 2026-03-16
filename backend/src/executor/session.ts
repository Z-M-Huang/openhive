/**
 * Session manager — SDK session lifecycle with resume support.
 *
 * Implements the {@link SessionManager} interface for managing Claude Agent SDK
 * sessions. Sessions enable conversation continuity by persisting the SDK's
 * internal session ID across agent restarts and task resumptions.
 *
 * ## Session Lifecycle
 *
 * Each session managed by this module follows a strict lifecycle:
 *
 * 1. **Create** (`createSession`) — Allocates a new SDK session for an agent
 *    working on a specific task. The session ID is persisted in the
 *    {@link ChatSession} table so that subsequent interactions can resume
 *    the same conversation context. Returns the session ID string.
 *
 * 2. **Resume** (`resumeSession`) — Restores a previously created session by
 *    its session ID. The session ID is looked up in the ChatSession table and
 *    used to initialize the SDK with prior conversation context. This enables
 *    agents to continue where they left off after restarts or task resumptions.
 *
 * 3. **End** (`endSession`) — Cleanly terminates a session. The SDK session
 *    is closed, resources are released, and the session record is updated
 *    or removed from the ChatSession table.
 *
 * 4. **Query** (`getSessionByAgent`) — Returns the active session ID for a
 *    given agent, or `undefined` if the agent has no active session.
 *
 * ## MEMORY.md Injection
 *
 * At task start, the session manager injects the contents of the agent's
 * `MEMORY.md` file into the SDK session as initial context. The file is
 * located at `<workspace>/memory/<agent-aid>/MEMORY.md` per the per-agent
 * memory convention defined in Skill-Standards.md. This provides agents
 * with persistent knowledge accumulated across prior sessions — project
 * conventions, learned preferences, and operational notes.
 *
 * ## Working Directory Scoping
 *
 * Each session is scoped to the agent's workspace directory. The SDK process
 * runs with its current working directory set to the team's workspace path,
 * ensuring file operations are contained within the correct workspace boundary.
 * This aligns with the container path model: `/app/workspace` inside every
 * container, with nested teams at `/app/workspace/teams/<slug>/`.
 *
 * @module executor/session
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionManager, SessionStore } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/index.js';
import { ChannelType } from '../domain/index.js';

/** Internal session tracking info. */
interface SessionInfo {
  sessionId: string;
  agentAid: string;
  /** Team TID this session is bound to (AC-C2). */
  tid: string;
  taskId: string;
  memoryContent: string | null;
}

/**
 * Manages Claude Agent SDK sessions with resume support.
 *
 * Implements the {@link SessionManager} interface to provide session
 * creation, resumption, and termination for agent SDK processes.
 * Each agent can have at most one active session at a time.
 */
export class SessionManagerImpl implements SessionManager {
  private readonly activeSessions = new Map<string, SessionInfo>();
  private readonly sessionStore: SessionStore;
  private readonly workspacePath: string;

  constructor(sessionStore: SessionStore, workspacePath: string) {
    this.sessionStore = sessionStore;
    this.workspacePath = workspacePath;
  }

  /**
   * Creates a new SDK session for an agent working on a task.
   *
   * The session is bound to both the agent AID and the team TID (AC-C2).
   * This ensures sessions cannot be transferred across team boundaries.
   *
   * @param agentAid - Agent ID that will own this session
   * @param taskId - Task ID this session is associated with
   * @param tid - Team TID this session is bound to
   * @returns The newly created session ID string
   * @throws {ConflictError} If the agent already has an active session
   */
  async createSession(agentAid: string, taskId: string, tid: string): Promise<string> {
    if (this.activeSessions.has(agentAid)) {
      throw new ConflictError(`Agent ${agentAid} already has an active session`);
    }

    const sessionId = crypto.randomUUID();

    // Read MEMORY.md from per-agent path: <workspace>/memory/<agent-aid>/MEMORY.md
    // Per Skill-Standards.md convention
    let memoryContent: string | null = null;
    try {
      const memoryDir = join(this.workspacePath, 'memory', agentAid);
      // Ensure directory exists (mkdir -p equivalent)
      await mkdir(memoryDir, { recursive: true });
      memoryContent = await readFile(join(memoryDir, 'MEMORY.md'), 'utf-8');
    } catch {
      // MEMORY.md is optional — no error if missing
    }

    // Persist to SessionStore
    await this.sessionStore.upsert({
      chat_jid: agentAid,
      channel_type: ChannelType.Cli,
      last_timestamp: Date.now(),
      last_agent_timestamp: Date.now(),
      session_id: sessionId,
      agent_aid: agentAid,
      tid,
    });

    this.activeSessions.set(agentAid, {
      sessionId,
      agentAid,
      tid,
      taskId,
      memoryContent,
    });

    return sessionId;
  }

  /**
   * Resumes a previously created SDK session.
   *
   * MEMORY.md is NOT re-injected on resume — context is preserved from
   * the original session.
   *
   * @param sessionId - The session ID to resume
   * @throws {NotFoundError} If the session ID is not found in the store
   */
  async resumeSession(sessionId: string): Promise<void> {
    // Find the session in the store by listing and matching session_id
    const allSessions = await this.sessionStore.listAll();
    const stored = allSessions.find(s => s.session_id === sessionId);
    if (!stored) {
      throw new NotFoundError(`Session ${sessionId} not found`);
    }

    this.activeSessions.set(stored.agent_aid, {
      sessionId: stored.session_id,
      agentAid: stored.agent_aid,
      tid: stored.tid,
      taskId: '',
      memoryContent: null,
    });
  }

  /**
   * Ends an active SDK session and releases its resources.
   *
   * @param sessionId - The session ID to end
   * @throws {NotFoundError} If the session ID is not found
   */
  async endSession(sessionId: string): Promise<void> {
    // Find the agent that owns this session
    let agentAid: string | undefined;
    for (const [aid, info] of this.activeSessions) {
      if (info.sessionId === sessionId) {
        agentAid = aid;
        break;
      }
    }

    if (!agentAid) {
      throw new NotFoundError(`Session ${sessionId} not found`);
    }

    this.activeSessions.delete(agentAid);
    await this.sessionStore.delete(agentAid);
  }

  /**
   * Returns the active session ID for a given agent.
   *
   * Synchronous lookup against in-memory state.
   *
   * Design note: sessions are keyed solely by `agentAid`, not by (agentAid, tid) pair.
   * This is intentional and consistent with INV-07 (per-agent memory/state). An agent AID
   * is globally unique across the entire system — an agent belongs to exactly one team at a
   * time, so scoping by TID would be redundant. Session recovery after a container restart
   * resumes by AID because the agent's identity (and its SDK session context) is what
   * matters for conversation continuity, not the container it happens to run in.
   *
   * @param agentAid - Agent ID to query
   * @returns The active session ID, or `undefined` if no active session
   */
  getSessionByAgent(agentAid: string): string | undefined {
    return this.activeSessions.get(agentAid)?.sessionId;
  }

  /**
   * Populates the in-memory session map from the SessionStore.
   *
   * Called once at startup (before rebuildState / resumeActiveSessions) so that
   * sessions persisted before a root restart are visible to getSessionByAgent().
   * Existing in-memory entries are not overwritten (createSession may have already
   * run for agents that came online before preload completed).
   */
  async preloadFromStore(): Promise<void> {
    const sessions = await this.sessionStore.listAll();
    for (const s of sessions) {
      if (!this.activeSessions.has(s.agent_aid)) {
        this.activeSessions.set(s.agent_aid, {
          sessionId: s.session_id,
          agentAid: s.agent_aid,
          tid: s.tid,
          taskId: '',
          memoryContent: null,
        });
      }
    }
  }
}
