/**
 * Optional secrets and vars. They are not in wrangler `secrets.required`, so a
 * deploy does not demand them and an empty or missing value leaves that source
 * dormant.
 * Set secrets with `wrangler secret put`. Do not put secret values in wrangler.jsonc.
 */
interface OptionalEnv {
  /** When set, Hospitable `Signature` is required. When unset, that check is skipped. */
  HOSPITABLE_WEBHOOK_SECRET?: string;
  /** Only the exact string "false" turns the Hospitable IP check off. Unset keeps it on. */
  ENFORCE_HOSPITABLE_IP?: string;
  /**
   * Quo signing secret. Current webhooks use `whsec_<base64>`. Legacy webhooks
   * use that same value without the prefix. When unset, POST /hook/<token>/quo returns 503.
   */
  QUO_WEBHOOK_SECRET?: string;
  /** WhatsApp hub.verify_token. Both this and the app secret must be set or the source is dormant. */
  WHATSAPP_VERIFY_TOKEN?: string;
  /** WhatsApp app secret for X-Hub-Signature-256. When either WhatsApp secret is unset, return 503. */
  WHATSAPP_APP_SECRET?: string;
}

interface Env extends OptionalEnv {}
declare namespace Cloudflare {
  interface Env extends OptionalEnv {}
}
