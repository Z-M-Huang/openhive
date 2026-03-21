/**
 * Service interfaces for OpenHive.
 *
 * All cross-module boundaries use interfaces from this file (C11, interface-first design).
 * Methods throw on error unless otherwise noted. All types reference domain.ts and enums.ts.
 *
 * This barrel re-exports all interfaces from the split sub-files.
 */

export * from './interfaces/supporting-types.js';
export * from './interfaces/stores.js';
export * from './interfaces/infrastructure.js';
export * from './interfaces/services.js';
