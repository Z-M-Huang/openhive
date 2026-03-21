/**
 * Persistence phase initialization: database, key manager, stores, SQLite sink.
 *
 * @module init/phase-persistence
 */

import { resolve } from 'node:path';

import type { MasterConfig } from '../config/defaults.js';
import type { Logger } from '../domain/interfaces.js';
import { Database } from '../storage/database.js';
import {
  newTaskStore,
  newMessageStore,
  newLogStore,
  newTaskEventStore,
  newToolCallStore,
  newDecisionStore,
  newSessionStore,
  newMemoryStore,
  newIntegrationStore,
} from '../storage/stores/index.js';
import { KeyManagerImpl } from '../security/key-manager.js';
import { SQLiteSink } from '../logging/sinks.js';

import type { ShutdownState } from './types.js';

/** Result of persistence phase initialization. */
export interface PersistenceResult {
  database: Database;
  keyManager: KeyManagerImpl;
  taskStore: ReturnType<typeof newTaskStore>;
  messageStore: ReturnType<typeof newMessageStore>;
  logStore: ReturnType<typeof newLogStore>;
  taskEventStore: ReturnType<typeof newTaskEventStore>;
  toolCallStore: ReturnType<typeof newToolCallStore>;
  decisionStore: ReturnType<typeof newDecisionStore>;
  sessionStore: ReturnType<typeof newSessionStore>;
  memoryStore: ReturnType<typeof newMemoryStore>;
  integrationStore: ReturnType<typeof newIntegrationStore>;
  credentialStore: Awaited<ReturnType<typeof createFileCredentialStore>>;
  sqliteSink: SQLiteSink;
}

// Lazily import file credential store to avoid top-level await
async function createFileCredentialStore(workspacePath: string) {
  const { createFileCredentialStore: create } = await import('../storage/stores/file-credential-store.js');
  return create(workspacePath);
}

/**
 * Initializes database, key manager, all stores, and SQLite log sink.
 */
export async function initPersistence(
  masterConfig: MasterConfig,
  logger: Logger,
  shutdownState: ShutdownState,
): Promise<PersistenceResult> {
  // 1. Validate master key
  const masterKey = process.env['OPENHIVE_MASTER_KEY'];
  if (!masterKey || masterKey.length < 32) {
    throw new Error('OPENHIVE_MASTER_KEY environment variable must be at least 32 characters');
  }

  // 2. Initialize database
  const dbPath = resolve(masterConfig.database.path);
  const database = new Database(dbPath);
  await database.initialize();
  shutdownState.database = database;

  logger.info('Database initialized', { path: dbPath });

  // 3. Initialize key manager
  const keyManager = new KeyManagerImpl();
  await keyManager.unlock(masterKey);
  shutdownState.keyManager = keyManager;

  logger.info('Key manager unlocked');

  // 4. Initialize stores
  const taskStore = newTaskStore(database);
  const messageStore = newMessageStore(database);
  const logStore = newLogStore(database);
  const taskEventStore = newTaskEventStore(database);
  const toolCallStore = newToolCallStore(database);
  const decisionStore = newDecisionStore(database);
  const sessionStore = newSessionStore(database);
  const memoryStore = newMemoryStore(database);
  const integrationStore = newIntegrationStore(database);
  // File-based credential store (plaintext files in workspace/.credentials/)
  const credentialStore = await createFileCredentialStore('/app/workspace');

  // Suppress unused warnings for stores that will be wired up later
  void messageStore;
  void decisionStore;
  // credentialStore is used in onConnect for secrets resolution

  // Add SQLite sink to logger for persistence
  const sqliteSink = new SQLiteSink(logStore);
  (logger as unknown as { sinks: unknown[] }).sinks.push(sqliteSink);

  logger.info('Stores initialized');

  return {
    database,
    keyManager,
    taskStore,
    messageStore,
    logStore,
    taskEventStore,
    toolCallStore,
    decisionStore,
    sessionStore,
    memoryStore,
    integrationStore,
    credentialStore,
    sqliteSink,
  };
}
