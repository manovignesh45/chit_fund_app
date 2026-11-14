import { createHash, timingSafeEqual } from 'crypto';

/**
 * Shared secret for the scheduled-job endpoints (/api/scheduled/*). The in-process
 * scheduler (lib/scheduler.ts) and email recovery (lib/emailRecovery.ts) send it as
 * `Authorization: Bearer <INTERNAL_API_KEY>`; the route handlers check it with
 * verifyInternalKey. There is no default: with the key unset, every call is refused.
 * Node runtime only (uses node:crypto).
 */
let warnedMissing = false;

export function getInternalApiKey(): string | null {
  const key = process.env.INTERNAL_API_KEY?.trim();
  if (key) return key;
  if (!warnedMissing) {
    warnedMissing = true;
    console.error('INTERNAL_API_KEY is not set: scheduled jobs are disabled and /api/scheduled/* refuses every request');
  }
  return null;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** True only when the request carries `Authorization: Bearer <INTERNAL_API_KEY>` and the key is set. */
export function verifyInternalKey(request: Request): boolean {
  const key = getInternalApiKey();
  if (!key) return false;

  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;

  // Hash both sides so the comparison is constant-time and length-independent.
  return timingSafeEqual(sha256(match[1].trim()), sha256(key));
}

/** Headers for an internal call to /api/scheduled/*, or null when INTERNAL_API_KEY is unset. */
export function internalAuthHeaders(): Record<string, string> | null {
  const key = getInternalApiKey();
  if (!key) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}
