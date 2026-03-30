/** Extract string values that look like credentials (length >= 8) from a record. */
export function extractStringCredentials(credentials: Record<string, unknown>): string[] {
  return Object.values(credentials).filter(
    (v): v is string => typeof v === 'string' && v.length >= 8,
  );
}
