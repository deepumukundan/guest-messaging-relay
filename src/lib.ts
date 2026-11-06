/**
 * Constants and pure helpers shared by the Worker and its tests.
 * They live here because a Worker's main module may export only handlers.
 */

export const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
/** Must match max_retries on the queue consumer in wrangler.jsonc. */
export const MAX_DELIVERY_RETRIES = 20;

/** Shortest relay password accepted. Shorter or non-alphanumeric values are refused. */
export const MIN_RELAY_TOKEN_LENGTH = 32;

/**
 * The Authorization header for the responder. A bare key (no space) gets
 * "Bearer " in front, so pasting just the Grok Bot key works too.
 */
export function authorizationValue(raw: string): string {
  const value = raw.trim();
  return /\s/.test(value) ? value : `Bearer ${value}`;
}

/**
 * Seconds before the next try: 60, 120, 240, ... capped at one hour.
 * With MAX_DELIVERY_RETRIES = 20 that spans about 15 hours, inside the
 * 24-hour message retention on the Workers Free plan.
 */
export function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(60 * 2 ** exponent, 3600);
}
