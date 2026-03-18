/**
 * PROPOSAL.md manager for the self-evolution system.
 *
 * Watches for PROPOSAL.md files in agent workspaces and manages the
 * proposal lifecycle: pending → approved/rejected → archived.
 *
 * When an agent writes a PROPOSAL.md file, this manager:
 * 1. Detects the file via workspace monitoring
 * 2. Publishes a `proposal.created` event on the EventBus
 * 3. Routes the proposal to the user for approval
 * 4. On approval, updates status to `approved` and publishes `proposal.approved`
 * 5. On rejection, updates status to `rejected` and publishes `proposal.rejected`
 *
 * The agent is responsible for executing approved proposals via its normal
 * tool access (create_agent, create_team, install_skill, etc.).
 *
 * @module evolution/proposal-manager
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { EventBus, Logger } from '../domain/index.js';

/** Proposal status values. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'archived';

/** Parsed proposal from a PROPOSAL.md file. */
export interface Proposal {
  /** File path of the PROPOSAL.md. */
  path: string;
  /** Current status. */
  status: ProposalStatus;
  /** Raw content of the file. */
  content: string;
  /** Agent AID that created the proposal (derived from workspace path). */
  agentAid: string;
  /** Team slug (derived from workspace path). */
  teamSlug: string;
}

/**
 * Manages PROPOSAL.md files for the self-evolution lifecycle.
 */
export class ProposalManager {
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly proposals = new Map<string, Proposal>();

  constructor(eventBus: EventBus, logger: Logger) {
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Process a newly detected PROPOSAL.md file.
   * Called by the file watcher when a PROPOSAL.md is created or modified.
   */
  async processProposal(
    filePath: string,
    agentAid: string,
    teamSlug: string,
  ): Promise<Proposal> {
    const content = await readFile(filePath, 'utf-8');

    // Extract status from content (look for **Status:** pattern)
    const statusMatch = content.match(/\*\*Status:\*\*\s*(\w+)/i);
    const status = (statusMatch?.[1]?.toLowerCase() ?? 'pending') as ProposalStatus;

    const proposal: Proposal = {
      path: filePath,
      status,
      content,
      agentAid,
      teamSlug,
    };

    this.proposals.set(filePath, proposal);

    if (status === 'pending') {
      this.eventBus.publish({
        type: 'proposal.created',
        data: {
          path: filePath,
          agent_aid: agentAid,
          team_slug: teamSlug,
          content_preview: content.slice(0, 500),
        },
        timestamp: Date.now(),
      });

      this.logger.info('New proposal detected', {
        path: filePath,
        agent_aid: agentAid,
        team_slug: teamSlug,
      });
    }

    return proposal;
  }

  /**
   * Approve a pending proposal. Updates the PROPOSAL.md status field.
   */
  async approve(filePath: string): Promise<void> {
    const proposal = this.proposals.get(filePath);
    if (!proposal) {
      throw new Error(`No proposal found at ${filePath}`);
    }
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal is not pending (current: ${proposal.status})`);
    }

    // Update status in file
    const updatedContent = proposal.content.replace(
      /\*\*Status:\*\*\s*pending/i,
      '**Status:** approved',
    );
    await writeFile(filePath, updatedContent, 'utf-8');

    proposal.status = 'approved';
    proposal.content = updatedContent;

    this.eventBus.publish({
      type: 'proposal.approved',
      data: {
        path: filePath,
        agent_aid: proposal.agentAid,
        team_slug: proposal.teamSlug,
      },
      timestamp: Date.now(),
    });

    this.logger.info('Proposal approved', { path: filePath });
  }

  /**
   * Reject a pending proposal with feedback.
   */
  async reject(filePath: string, feedback?: string): Promise<void> {
    const proposal = this.proposals.get(filePath);
    if (!proposal) {
      throw new Error(`No proposal found at ${filePath}`);
    }
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal is not pending (current: ${proposal.status})`);
    }

    // Update status and append feedback
    let updatedContent = proposal.content.replace(
      /\*\*Status:\*\*\s*pending/i,
      '**Status:** rejected',
    );
    if (feedback) {
      updatedContent += `\n\n### Rejection Feedback\n${feedback}\n`;
    }
    await writeFile(filePath, updatedContent, 'utf-8');

    proposal.status = 'rejected';
    proposal.content = updatedContent;

    this.eventBus.publish({
      type: 'proposal.rejected',
      data: {
        path: filePath,
        agent_aid: proposal.agentAid,
        team_slug: proposal.teamSlug,
        feedback: feedback ?? '',
      },
      timestamp: Date.now(),
    });

    this.logger.info('Proposal rejected', { path: filePath, feedback });
  }

  /** Get all tracked proposals. */
  getProposals(): Proposal[] {
    return [...this.proposals.values()];
  }

  /** Get pending proposals. */
  getPending(): Proposal[] {
    return [...this.proposals.values()].filter(p => p.status === 'pending');
  }
}
