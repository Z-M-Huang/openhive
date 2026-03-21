/**
 * Store implementations for all 10 database stores + Transactor.
 *
 * Each factory accepts a Database instance and returns an object implementing
 * the corresponding store interface from domain/interfaces.ts. Reads use
 * db.getDB() directly (WAL snapshot isolation). Writes use db.enqueueWrite()
 * for serialized mutation (INV-04).
 *
 * @module storage/stores
 */

export { newTaskStore } from './task-store.js';
export { newMessageStore } from './message-store.js';
export { newLogStore } from './log-store.js';
export { newTaskEventStore } from './task-event-store.js';
export { newToolCallStore } from './tool-call-store.js';
export { newDecisionStore } from './decision-store.js';
export { newSessionStore } from './session-store.js';
export { newMemoryStore } from './memory-store.js';
export { newIntegrationStore } from './integration-store.js';
export { newCredentialStore } from './credential-store.js';
export { newTransactor } from './transactor.js';
