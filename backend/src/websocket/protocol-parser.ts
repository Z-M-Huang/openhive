/**
 * WebSocket protocol parsing and direction enforcement.
 *
 * @module websocket/protocol-parser
 */

import { ValidationError } from '../domain/errors.js';
import type { WSMessage } from './protocol-types.js';
import {
  ROOT_TO_CONTAINER_TYPES,
  CONTAINER_TO_ROOT_TYPES,
  MESSAGE_SCHEMAS,
} from './protocol-types.js';

// ---------------------------------------------------------------------------
// Wire format conversion
// ---------------------------------------------------------------------------

/**
 * Converts an internal WSMessage to wire format (JSON string).
 * Protocol-level fields use snake_case. Nested domain types (AgentInitConfig,
 * ResolvedProvider) retain camelCase from domain/interfaces.ts -- wire-specific
 * snake_case conversion for nested payloads is deferred to L4.
 */
export function toWireFormat(message: WSMessage): string {
  return JSON.stringify({ type: message.type, data: message.data });
}

/**
 * Parses a raw wire-format JSON string into a typed WSMessage.
 * Validates the message structure, type discriminator, and payload schema.
 * This is the PRIMARY TRUST BOUNDARY for all inter-container communication.
 * Throws on invalid JSON, unknown message type, schema violation, or size limit exceeded.
 * AC-L4-08: Per-message-type payload validation.
 */
export function parseMessage(raw: string): WSMessage {
  // 1MB check BEFORE JSON.parse to prevent memory exhaustion attacks
  if (Buffer.byteLength(raw, 'utf8') > 1_048_576) {
    throw new ValidationError('Message exceeds maximum size');
  }

  // Parse JSON - throw sanitized error, never echo raw input
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Invalid JSON message');
  }

  // Validate shape: must be a non-null object (not array, not primitive)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new ValidationError('Message must be a non-null object');
  }

  const message = parsed as Record<string, unknown>;

  // Validate 'type' field exists and is a string
  if (typeof message.type !== 'string') {
    throw new ValidationError('Message type must be a string');
  }

  // Validate type is in whitelist
  if (
    !ROOT_TO_CONTAINER_TYPES.has(message.type) &&
    !CONTAINER_TO_ROOT_TYPES.has(message.type)
  ) {
    throw new ValidationError('Unknown message type');
  }

  // Validate 'data' field exists and is a non-null object
  if (
    typeof message.data !== 'object' ||
    message.data === null ||
    Array.isArray(message.data)
  ) {
    throw new ValidationError('Message data must be a non-null object');
  }

  // AC-L4-08: Validate payload against per-message-type schema
  const schema = MESSAGE_SCHEMAS[message.type];
  if (schema) {
    const result = schema.safeParse(message.data);
    if (!result.success) {
      throw new ValidationError(`Invalid ${message.type} payload: ${result.error.issues[0]?.message || 'validation failed'}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { type: message.type, data: message.data } as WSMessage;
}

/**
 * AC-L4-08: Extended parse with optional payload schema validation.
 * This combines structural parsing with payload validation in a single call.
 * Use this when you want all validation in one place.
 */
export function parseMessageWithValidation(
  raw: string,
  schemaValidator?: (message: WSMessage) => void,
): WSMessage {
  const message = parseMessage(raw);
  if (schemaValidator) {
    schemaValidator(message);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Direction enforcement
// ---------------------------------------------------------------------------

/**
 * Validates that a message type flows in the expected direction.
 *
 * @param messageType - The message type string (e.g., 'container_init').
 * @param direction - Expected direction: 'root_to_container' or 'container_to_root'.
 * @returns true if the message type matches the expected direction.
 * @throws Error if the message type is unknown.
 */
export function validateDirection(
  messageType: string,
  direction: 'root_to_container' | 'container_to_root'
): boolean {
  const types = direction === 'root_to_container'
    ? ROOT_TO_CONTAINER_TYPES
    : CONTAINER_TO_ROOT_TYPES;
  if (!ROOT_TO_CONTAINER_TYPES.has(messageType) && !CONTAINER_TO_ROOT_TYPES.has(messageType)) {
    throw new Error(`Unknown message type: "${messageType}"`);
  }
  return types.has(messageType);
}
