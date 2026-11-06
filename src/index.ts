/**
 * guest-messaging-relay
 *
 * Receive-only Worker. Hospitable, Quo, and WhatsApp webhooks are normalized
 * and forwarded to a responder webhook. This Worker never calls a send-message API.
 *
 * Delivery is queue-backed. The fetch handler checks the request, puts one job
 * per message on the DELIVERY queue, and only then returns 200. If the queue
 * cannot take the job, it returns 500 so the sender retries.
 *
 * The queue handler POSTs each job to the responder. A failure is retried by
 * Cloudflare Queues with growing delays (see retryDelaySeconds). After
 * MAX_DELIVERY_RETRIES the job moves to the dead-letter queue. The dedupe key
 * is written only after a successful forward, so a redelivery is not skipped.
 */

import {
  authorizationValue,
  DEDUPE_TTL_SECONDS,
  MIN_RELAY_TOKEN_LENGTH,
  retryDelaySeconds,
} from "./lib";
import { SETUP_PAGE_HTML } from "./setup-page";
import { emitPayloadShape } from "./shape-diagnostics";


/** Log prefix. Every status line is JSON and includes this as `relay`. */
const LOG_PREFIX = "guest-messaging-relay";

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGE_CHARS = 4000;
const QUO_MAX_SKEW_MS = 5 * 60 * 1000;
const ROUTINE_TIMEOUT_MS = 30_000;
/** Queue messages are capped at 128 KB. Larger jobs skip the queue. */
const MAX_QUEUE_JOB_BYTES = 120_000;
const MAX_SEND_BATCH = 100;

/**
 * Message.source values that are not a guest writing on the booking channel.
 * From the Public API Message schema.
 */
const NON_GUEST_SOURCES = new Set(["automated", "AI", "public_api", "hospitable"]);

const SLIM_KEYS = [
  "event_id",
  "message_id",
  "reservation_id",
  "conversation_id",
  "property_id",
  "property_name",
  "platform",
  "sender_type",
  "created_at",
  "body",
  "content_type",
  "guest_first_name",
  "guest_location",
] as const;

type SlimKey = (typeof SLIM_KEYS)[number];
type SlimBody = Partial<Record<SlimKey, string>> & {
  event_type: "message.created";
  sender_type: "guest";
};

interface ReviewBody {
  event_type: "review.created";
  event_id: string;
  created?: string;
  review_id?: string;
  platform?: string;
  rating?: number;
  can_respond?: boolean;
  has_response: boolean;
  reservation_id?: string;
  reservation_code?: string;
  check_in?: string;
  check_out?: string;
  property_id?: string;
  property_name?: string;
  guest_first_name?: string;
  review: Record<string, unknown>;
}

interface ReservationBody {
  event_type: "reservation.created" | "reservation.changed";
  event_id: string;
  created?: string;
  reservation_id?: string;
  code?: string;
  platform?: string;
  status?: string;
  property_id?: string;
  property_name?: string;
  property_city?: string;
  property_state?: string;
  check_in?: string;
  check_out?: string;
  nights?: number;
  guest_count?: number;
  guest_first_name?: string;
  triggers?: unknown[];
  reservation: Record<string, unknown>;
}

interface HospitableSender {
  first_name?: string;
}

type HospitableMessage = SlimBody & {
  source: "hospitable";
  inbox: "hospitable";
  sender: HospitableSender;
  /** Present only when Hospitable sent a property name. */
  property?: string;
  truncated?: true;
};

interface RelaySender {
  phone?: string;
  id?: string;
  first_name?: string;
}

interface RelayMessage {
  source: "quo" | "whatsapp";
  event_type: "message";
  /**
   * Quo: the receiving line in E.164 (`to`).
   * WhatsApp: metadata.phone_number_id.
   * Omitted when the source did not send one.
   */
  inbox?: string;
  sender: RelaySender;
  message_id: string;
  body: string;
  created_at: string;
  truncated?: true;
  media_type?: string;
  media_id?: string;
}

type RoutinePayload = HospitableMessage | ReviewBody | ReservationBody | RelayMessage;

type Outcome =
  | "rejected_path"
  | "rejected_method"
  | "rejected_ip"
  | "rejected_signature"
  | "rejected_verify"
  | "invalid_payload"
  | "payload_too_large"
  | "misconfigured"
  | "dormant"
  | "dropped_action"
  | "dropped_non_guest"
  | "dropped_no_id"
  | "duplicate"
  | "dedupe_read_failed"
  | "ignored"
  | "stale_timestamp"
  | "verified"
  | "forwarded"
  | "forward_failed"
  | "dedupe_write_failed"
  | "queue_failed"
  | "queue_bypassed_size";

interface LogFields {
  event_id: string | null;
  message_id: string | null;
  outcome: Outcome;
  routine_status: number | null;
  /** Set only when Hospitable signature verification is skipped. Never the header value. */
  signature_present?: boolean;
  /** Present on dropped_non_guest only when the payload field is a string. */
  sender_type?: string;
  sender_role?: string;
  msg_source?: string;
  /** Webhook action. Set for non-message Hospitable routes and for dropped_action. */
  action?: string | null;
  source?: "hospitable" | "quo" | "whatsapp";
  event_type?: string;
  reason?: "event_type" | "direction" | "statuses";
  /** Queue delivery attempt, starting at 1. */
  attempt?: number;
}

type LogExtra = Pick<LogFields, "signature_present" | "action" | "source" | "event_type" | "reason">;

/** One message waiting for delivery to the responder. */
export interface DeliveryJob {
  key: string;
  event_id: string | null;
  message_id: string | null;
  log: LogExtra;
  payload: RoutinePayload;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return setupPage();
    }

    if (!configured(env)) {
      logEvent({
        event_id: null,
        message_id: null,
        outcome: "misconfigured",
        routine_status: null,
      });
      return json({ error: "misconfigured" }, 500);
    }

    const route = await matchRoute(url.pathname, env.RELAY_PATH_TOKEN);
    if (route === null) {
      logEvent({
        event_id: null,
        message_id: null,
        outcome: "rejected_path",
        routine_status: null,
      });
      return json({ error: "not_found" }, 404);
    }

    if (route === "status") {
      return handleStatus(request, env);
    }
    if (route === "hospitable") {
      return handleHospitable(request, env, ctx);
    }
    if (route === "quo") {
      if (request.method !== "POST") {
        logSource("quo", {
          event_id: null,
          message_id: null,
          outcome: "rejected_path",
          routine_status: null,
        });
        return json({ error: "not_found" }, 404);
      }
      return handleQuo(request, env, ctx);
    }
    if (request.method !== "GET" && request.method !== "POST") {
      logSource("whatsapp", {
        event_id: null,
        message_id: null,
        outcome: "rejected_path",
        routine_status: null,
      });
      return json({ error: "not_found" }, 404);
    }
    return handleWhatsapp(request, env, ctx);
  },

  async queue(batch, env, _ctx): Promise<void> {
    for (const message of batch.messages) {
      await consumeJob(message as Message<DeliveryJob>, env);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleHospitable(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const secret = webhookSecret(env);
    const signatureNote: Pick<LogFields, "signature_present"> = secret
      ? {}
      : { signature_present: request.headers.has("Signature") };

    if (request.method !== "POST") {
      logHospitable({
        event_id: null,
        message_id: null,
        outcome: "rejected_method",
        routine_status: null,
        ...signatureNote,
      });
      return json({ error: "method_not_allowed" }, 405);
    }

    if (ipCheckEnabled(env) && !isHospitableSourceIp(request.headers.get("CF-Connecting-IP"))) {
      logHospitable({
        event_id: null,
        message_id: null,
        outcome: "rejected_ip",
        routine_status: null,
        ...signatureNote,
      });
      return json({ error: "unauthorized" }, 401);
    }

    const body = await readBoundedBody(request, MAX_BODY_BYTES);
    if (body === null) {
      logHospitable({
        event_id: null,
        message_id: null,
        outcome: "payload_too_large",
        routine_status: null,
        ...signatureNote,
      });
      return json({ error: "payload_too_large" }, 413);
    }

    if (secret) {
      const signatureOk = await verifySignature(secret, body, request.headers.get("Signature"));
      if (!signatureOk) {
        logHospitable({
          event_id: null,
          message_id: null,
          outcome: "rejected_signature",
          routine_status: null,
        });
        return json({ error: "unauthorized" }, 401);
      }
    }

    const parsed = parseWebhook(body);
    if (!parsed.ok) {
      logHospitable({
        event_id: null,
        message_id: null,
        outcome: "invalid_payload",
        routine_status: null,
        ...signatureNote,
      });
      return json({ error: "invalid_payload" }, 400);
    }

    const eventId = parsed.eventId;
    const messageId = parsed.messageId;

    if (
      parsed.action === "review.created" ||
      parsed.action === "reservation.created" ||
      parsed.action === "reservation.changed"
    ) {
      if (!eventId || parsed.data === null) {
        logHospitable({
          event_id: eventId,
          message_id: messageId,
          outcome: "dropped_no_id",
          routine_status: null,
          action: parsed.action,
          ...signatureNote,
        });
        return json({ ok: true }, 200);
      }
      const eventKey = `event:${eventId}`;
      let seenEvent: string | null;
      try {
        seenEvent = await env.DEDUPE.get(eventKey);
      } catch {
        logHospitable({
          event_id: eventId,
          message_id: messageId,
          outcome: "dedupe_read_failed",
          routine_status: null,
          action: parsed.action,
          ...signatureNote,
        });
        return json({ error: "dedupe_unavailable" }, 500);
      }
      if (seenEvent !== null) {
        logHospitable({
          event_id: eventId,
          message_id: messageId,
          outcome: "duplicate",
          routine_status: null,
          action: parsed.action,
          ...signatureNote,
        });
        return json({ ok: true }, 200);
      }
      const forwarded =
        parsed.action === "review.created"
          ? reviewBody(eventId, parsed.created, parsed.data)
          : reservationBody(parsed.action, eventId, parsed.created, parsed.data, parsed.triggers);
      const queued = await enqueue(env, ctx, [
        {
          key: eventKey,
          event_id: eventId,
          message_id: messageId,
          log: { source: "hospitable", action: parsed.action, ...signatureNote },
          payload: forwarded,
        },
      ]);
      if (!queued) {
        return json({ error: "queue_unavailable" }, 500);
      }
      return json({ ok: true }, 200);
    }

    if (parsed.action !== "message.created") {
      logHospitable({
        event_id: eventId,
        message_id: messageId,
        outcome: "dropped_action",
        routine_status: null,
        action: parsed.action,
        ...signatureNote,
      });
      return json({ ok: true }, 200);
    }

    if (parsed.data === null || !isGuestWritten(parsed.data)) {
      logHospitable({
        event_id: eventId,
        message_id: messageId,
        outcome: "dropped_non_guest",
        routine_status: null,
        ...signatureNote,
        ...senderLogFields(parsed.data),
      });
      return json({ ok: true }, 200);
    }

    const key = dedupeKey(messageId, eventId);
    if (!key) {
      logHospitable({
        event_id: eventId,
        message_id: messageId,
        outcome: "dropped_no_id",
        routine_status: null,
        ...signatureNote,
      });
      return json({ ok: true }, 200);
    }

    let seen: string | null;
    try {
      seen = await env.DEDUPE.get(key);
    } catch {
      logHospitable({
        event_id: eventId,
        message_id: messageId,
        outcome: "dedupe_read_failed",
        routine_status: null,
        ...signatureNote,
      });
      return json({ error: "dedupe_unavailable" }, 500);
    }

    if (seen !== null) {
      logHospitable({
        event_id: eventId,
        message_id: messageId,
        outcome: "duplicate",
        routine_status: null,
        ...signatureNote,
      });
      return json({ ok: true }, 200);
    }

    const slim = slimBody(eventId, messageId, parsed.data);
    const queued = await enqueue(env, ctx, [
      {
        key,
        event_id: eventId,
        message_id: messageId,
        log: { source: "hospitable", ...signatureNote },
        payload: slim,
      },
    ]);
    if (!queued) {
      return json({ error: "queue_unavailable" }, 500);
    }
    return json({ ok: true }, 200);
}

/**
 * Required settings are present and usable: a relay password of at least
 * MIN_RELAY_TOKEN_LENGTH letters and digits, an https responder URL, and an
 * Authorization value. Anything else fails closed with 500, so a placeholder
 * or weak password copied from a public example never goes live.
 */
function configured(env: Env): boolean {
  const token = env.RELAY_PATH_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9]+$/.test(token) || token.length < MIN_RELAY_TOKEN_LENGTH) {
    return false;
  }
  if (typeof env.RESPONDER_AUTH_HEADER !== "string" || env.RESPONDER_AUTH_HEADER.trim().length === 0) {
    return false;
  }
  try {
    return new URL(env.RESPONDER_WEBHOOK_URL).protocol === "https:";
  } catch {
    return false;
  }
}

/** Non-empty HOSPITABLE_WEBHOOK_SECRET turns signature checks on. Empty or unset skips them. */
function webhookSecret(env: Env): string | null {
  const value = env.HOSPITABLE_WEBHOOK_SECRET;
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

/**
 * /hook/<token>, /hook/<token>/hospitable, /hook/<token>/quo, /hook/<token>/whatsapp,
 * and /hook/<token>/status (used by the setup page).
 * The token is compared in constant time. Any other shape is rejected.
 */
async function matchRoute(
  pathname: string,
  expected: string,
): Promise<"hospitable" | "quo" | "whatsapp" | "status" | null> {
  const match = /^\/hook\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  const presented = match?.[1] ?? "";
  const tokenOk = await timingSafeEqualString(presented, expected);
  if (!match || !tokenOk) {
    return null;
  }
  const suffix = match[2];
  if (suffix === undefined || suffix === "hospitable") {
    return "hospitable";
  }
  if (suffix === "quo") {
    return "quo";
  }
  if (suffix === "whatsapp") {
    return "whatsapp";
  }
  if (suffix === "status") {
    return "status";
  }
  return null;
}

/** Unset keeps the IP check on. Only the exact string "false" turns it off. */
function ipCheckEnabled(env: Env): boolean {
  return env.ENFORCE_HOSPITABLE_IP !== "false";
}

/**
 * Hospitable publishes the source range as 38.80.170.0/24.
 * That is 38.80.170.0 through 38.80.170.255.
 */
function isHospitableSourceIp(header: string | null): boolean {
  if (!header) {
    return false;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(header.trim());
  if (!match) {
    return false;
  }
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  return octets[0] === 38 && octets[1] === 80 && octets[2] === 170;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifySignature(
  secret: string,
  body: Uint8Array,
  signature: string | null,
): Promise<boolean> {
  if (!signature || signature.trim().length === 0) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, body);
  const expected = toHex(mac);
  return timingSafeEqualString(expected, signature.trim().toLowerCase());
}

async function timingSafeEqualString(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

interface ParsedWebhook {
  ok: true;
  eventId: string | null;
  action: string | null;
  created: string | null;
  triggers: unknown[] | null;
  messageId: string | null;
  data: Record<string, unknown> | null;
}

function parseWebhook(body: Uint8Array): ParsedWebhook | { ok: false } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return { ok: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }
  const record = value as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  return {
    ok: true,
    eventId: asString(record.id),
    action: asString(record.action),
    created: asString(record.created),
    triggers: Array.isArray(record.triggers) ? record.triggers : null,
    messageId: data ? asString(data.id) : null,
    data,
  };
}

/**
 * Fail closed on sender_type. sender_role is not part of the check: live guest
 * webhooks use values such as "owner" or null.
 * Scheduled, auto-reply, in-app, and API-sent messages are dropped via source
 * even when sender_type is guest.
 */
function isGuestWritten(data: Record<string, unknown> | null): boolean {
  if (!data) {
    return false;
  }
  if (data.sender_type !== "guest") {
    return false;
  }
  if (typeof data.source === "string" && NON_GUEST_SOURCES.has(data.source)) {
    return false;
  }
  return true;
}

function senderLogFields(
  data: Record<string, unknown> | null,
): Pick<LogFields, "sender_type" | "sender_role" | "msg_source"> {
  return {
    sender_type: stringField(data?.sender_type),
    sender_role: stringField(data?.sender_role),
    msg_source: stringField(data?.source),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function dedupeKey(messageId: string | null, eventId: string | null): string | null {
  if (messageId) {
    return `message:${messageId}`;
  }
  if (eventId) {
    return `event:${eventId}`;
  }
  return null;
}

function slimBody(
  eventId: string | null,
  messageId: string | null,
  data: Record<string, unknown>,
): HospitableMessage {
  const slim: Record<string, unknown> = { event_type: "message.created", sender_type: "guest" };
  assign(slim, "event_id", eventId);
  assign(slim, "message_id", messageId);
  assign(slim, "reservation_id", asString(data.reservation_id));
  assign(slim, "conversation_id", asString(data.conversation_id));
  assign(slim, "property_id", propertyId(data));
  assign(slim, "property_name", propertyName(data));
  assign(slim, "platform", platformOf(data));
  assign(slim, "created_at", asString(data.created_at));
  assign(slim, "body", asString(data.body));
  assign(slim, "content_type", asString(data.content_type));
  assign(slim, "guest_first_name", nestedString(data.sender, "first_name"));
  assign(slim, "guest_location", nestedString(data.sender, "location"));
  if (typeof slim.body === "string") {
    const capped = capText(slim.body);
    slim.body = capped.text;
    if (capped.truncated) {
      slim.truncated = true;
    }
  }
  const sender: HospitableSender = {};
  const firstName = nestedString(data.sender, "first_name");
  if (firstName) {
    sender.first_name = firstName;
  }
  slim.source = "hospitable";
  slim.inbox = "hospitable";
  slim.sender = sender;
  const property = propertyName(data);
  if (property) {
    slim.property = property;
  }
  return slim as unknown as HospitableMessage;
}

function reviewBody(eventId: string, created: string | null, data: Record<string, unknown>): ReviewBody {
  const out: Record<string, unknown> = {
    event_type: "review.created",
    event_id: eventId,
  };
  assign(out, "created", created);
  assign(out, "review_id", asString(data.id));
  assign(out, "platform", asString(data.platform));
  const pub =
    data.public && typeof data.public === "object" ? (data.public as Record<string, unknown>) : null;
  if (pub && typeof pub.rating === "number") {
    out.rating = pub.rating;
  }
  if (typeof data.can_respond === "boolean") {
    out.can_respond = data.can_respond;
  }
  out.has_response = !!(pub && pub.response);
  assign(out, "reservation_id", nestedString(data.reservation, "id"));
  assign(out, "reservation_code", nestedString(data.reservation, "code"));
  assign(out, "check_in", nestedString(data.reservation, "check_in"));
  assign(out, "check_out", nestedString(data.reservation, "check_out"));
  assign(out, "property_id", nestedString(data.property, "id"));
  assign(out, "property_name", nestedString(data.property, "name") ?? nestedString(data.property, "public_name"));
  assign(out, "guest_first_name", nestedString(data.guest, "first_name"));
  out.review = data;
  return out as unknown as ReviewBody;
}

const KEEP_PROPERTY_KEYS = [
  "id",
  "name",
  "public_name",
  "timezone",
  "checkin",
  "checkout",
  "capacity",
  "house_rules",
] as const;

function slimProperty(property: unknown): unknown {
  if (!property || typeof property !== "object") {
    return property;
  }
  const source = property as Record<string, unknown>;
  const slim: Record<string, unknown> = {};
  for (const key of KEEP_PROPERTY_KEYS) {
    if (source[key] !== undefined) {
      slim[key] = source[key];
    }
  }
  return slim;
}

function reservationBody(
  action: "reservation.created" | "reservation.changed",
  eventId: string,
  created: string | null,
  data: Record<string, unknown>,
  triggers: unknown[] | null,
): ReservationBody {
  const out: Record<string, unknown> = {
    event_type: action,
    event_id: eventId,
  };
  assign(out, "created", created);
  assign(out, "reservation_id", asString(data.id));
  assign(out, "code", asString(data.code));
  assign(out, "platform", asString(data.platform));
  const status = data.reservation_status;
  const statusCurrent =
    status && typeof status === "object" ? (status as Record<string, unknown>).current : undefined;
  assign(out, "status", asString(data.status) ?? nestedString(statusCurrent, "category"));
  const props = Array.isArray(data.properties) ? data.properties : [];
  const prop = props[0];
  assign(out, "property_id", nestedString(prop, "id"));
  assign(out, "property_name", nestedString(prop, "name") ?? nestedString(prop, "public_name"));
  const address =
    prop && typeof prop === "object" ? (prop as Record<string, unknown>).address : undefined;
  assign(out, "property_city", nestedString(address, "city"));
  assign(out, "property_state", nestedString(address, "state"));
  assign(out, "check_in", asString(data.check_in));
  assign(out, "check_out", asString(data.check_out));
  if (typeof data.nights === "number") {
    out.nights = data.nights;
  }
  const guests = data.guests;
  if (guests && typeof guests === "object" && typeof (guests as Record<string, unknown>).total === "number") {
    out.guest_count = (guests as Record<string, unknown>).total;
  }
  assign(out, "guest_first_name", nestedString(data.guest, "first_name"));
  if (triggers) {
    out.triggers = triggers;
  }
  const reservation: Record<string, unknown> = { ...data };
  if (Array.isArray(data.properties)) {
    reservation.properties = data.properties.map((property) => slimProperty(property));
  }
  if (data.property) {
    reservation.property = slimProperty(data.property);
  }
  out.reservation = reservation;
  return out as unknown as ReservationBody;
}

function assign(target: Record<string, unknown>, key: string, value: string | null): void {
  if (value) {
    target[key] = value;
  }
}

function propertyId(data: Record<string, unknown>): string | null {
  return nestedString(data.property, "id") ?? asString(data.property_id);
}

function propertyName(data: Record<string, unknown>): string | null {
  return (
    nestedString(data.property, "name") ??
    nestedString(data.property, "public_name") ??
    asString(data.property_name)
  );
}

function platformOf(data: Record<string, unknown>): string | null {
  return asString(data.platform) ?? nestedString(data.listing, "platform");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nestedString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return asString((value as Record<string, unknown>)[key]);
}

function asString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Put jobs on the delivery queue. Returns false when the queue rejects them,
 * so the caller can answer 500 and the sender retries. A job too large for a
 * queue message is delivered once directly instead (best effort).
 */
async function enqueue(env: Env, ctx: ExecutionContext, jobs: DeliveryJob[]): Promise<boolean> {
  const encoder = new TextEncoder();
  const queueable: DeliveryJob[] = [];
  for (const job of jobs) {
    if (encoder.encode(JSON.stringify(job)).byteLength > MAX_QUEUE_JOB_BYTES) {
      logEvent(
        {
          event_id: job.event_id,
          message_id: job.message_id,
          outcome: "queue_bypassed_size",
          routine_status: null,
          ...job.log,
        },
        "error",
      );
      ctx.waitUntil(deliverOnce(env, job, 1).then(() => undefined));
    } else {
      queueable.push(job);
    }
  }
  try {
    for (let index = 0; index < queueable.length; index += MAX_SEND_BATCH) {
      const chunk = queueable.slice(index, index + MAX_SEND_BATCH);
      await (env.DELIVERY as Queue<DeliveryJob>).sendBatch(chunk.map((body) => ({ body })));
    }
  } catch {
    for (const job of queueable) {
      logEvent(
        {
          event_id: job.event_id,
          message_id: job.message_id,
          outcome: "queue_failed",
          routine_status: null,
          ...job.log,
        },
        "error",
      );
    }
    return false;
  }
  return true;
}

/** Queue consumer for one job. Ack on success or duplicate, retry otherwise. */
async function consumeJob(message: Message<DeliveryJob>, env: Env): Promise<void> {
  const job = message.body;
  if (!job || typeof job !== "object" || typeof job.key !== "string" || !job.payload) {
    logEvent({ event_id: null, message_id: null, outcome: "invalid_payload", routine_status: null }, "error");
    message.ack();
    return;
  }
  const attempt = message.attempts;
  let seen: string | null;
  try {
    seen = await env.DEDUPE.get(job.key);
  } catch {
    logEvent({
      event_id: job.event_id,
      message_id: job.message_id,
      outcome: "dedupe_read_failed",
      routine_status: null,
      attempt,
      ...job.log,
    });
    message.retry({ delaySeconds: retryDelaySeconds(attempt) });
    return;
  }
  if (seen !== null) {
    logEvent({
      event_id: job.event_id,
      message_id: job.message_id,
      outcome: "duplicate",
      routine_status: null,
      attempt,
      ...job.log,
    });
    message.ack();
    return;
  }
  if (await deliverOnce(env, job, attempt)) {
    message.ack();
  } else {
    message.retry({ delaySeconds: retryDelaySeconds(attempt) });
  }
}

/** One POST to the responder. On 2xx, store the dedupe key. Returns success. */
async function deliverOnce(env: Env, job: DeliveryJob, attempt: number): Promise<boolean> {
  let routineStatus = 0;
  try {
    const response = await fetch(env.RESPONDER_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationValue(env.RESPONDER_AUTH_HEADER),
      },
      body: JSON.stringify(job.payload),
      signal: AbortSignal.timeout(ROUTINE_TIMEOUT_MS),
    });
    routineStatus = response.status;
    await response.body?.cancel();
  } catch {
    routineStatus = 0;
  }
  const base = { event_id: job.event_id, message_id: job.message_id, routine_status: routineStatus, attempt };
  if (routineStatus < 200 || routineStatus > 299) {
    logEvent({ ...base, outcome: "forward_failed", ...job.log }, "error");
    return false;
  }
  try {
    await env.DEDUPE.put(job.key, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
  } catch {
    logEvent({ ...base, outcome: "dedupe_write_failed", ...job.log }, "error");
    return true;
  }
  logEvent({ ...base, outcome: "forwarded", ...job.log });
  return true;
}

/** The setup page. Static, no secrets, never cached or framed. */
function setupPage(): Response {
  return new Response(SETUP_PAGE_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * GET /hook/<token>/status. Reached only with the right relay password.
 * Says which channels have their secrets set. Never returns secret values.
 */
function handleStatus(request: Request, env: Env): Response {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }
  const body = {
    relay: "ok",
    channels: {
      hospitable: true,
      quo: optionalSecret(env.QUO_WEBHOOK_SECRET) !== null,
      whatsapp: whatsappCreds(env) !== null,
    },
  };
  return Response.json(body, {
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function logHospitable(fields: Omit<LogFields, "source">, level: "log" | "error" = "log"): void {
  logEvent({ ...fields, source: "hospitable" }, level);
}

function logSource(
  source: "quo" | "whatsapp",
  fields: Omit<LogFields, "source">,
  level: "log" | "error" = "log",
): void {
  logEvent({ ...fields, source }, level);
}

/**
 * Extra shape line for a verified POST on a source that still has diagnostics
 * enabled. `outcome` is null when the request was accepted for delivery; the
 * queue status line still reports forwarded or forward_failed. Failures here
 * must not change the response.
 */
function logShape(
  source: "quo" | "whatsapp",
  body: Uint8Array,
  outcome: Outcome | null,
  reason: LogFields["reason"] | null = null,
): void {
  try {
    emitPayloadShape(LOG_PREFIX, source, body, outcome, reason);
  } catch {
    // Diagnostics must not change the response.
  }
}

function logEvent(fields: LogFields, level: "log" | "error" = "log"): void {
  const record: Record<string, string | number | boolean | null> = {
    relay: LOG_PREFIX,
    event_id: fields.event_id,
    message_id: fields.message_id,
    outcome: fields.outcome,
    routine_status: fields.routine_status,
  };
  for (const key of ["action", "sender_type", "sender_role", "msg_source", "source", "reason", "attempt"] as const) {
    const value = fields[key];
    if (value !== undefined) {
      record[key] = value;
    }
  }
  if (typeof fields.event_type === "string") {
    record.event_type = fields.event_type;
  }
  if (fields.signature_present !== undefined) {
    record.signature_present = fields.signature_present;
  }
  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function json(body: Record<string, string | boolean>, status: number): Response {
  return Response.json(body, { status });
}

async function handleQuo(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = optionalSecret(env.QUO_WEBHOOK_SECRET);
  if (!secret) {
    logSource("quo", {
      event_id: null,
      message_id: null,
      outcome: "dormant",
      routine_status: null,
    });
    return json({ error: "dormant" }, 503);
  }

  const body = await readBoundedBody(request, MAX_BODY_BYTES);
  if (body === null) {
    logSource("quo", {
      event_id: null,
      message_id: null,
      outcome: "payload_too_large",
      routine_status: null,
    });
    return json({ error: "payload_too_large" }, 413);
  }

  const verdict = await verifyQuoRequest(secret, body, request);
  if (verdict !== "ok") {
    logSource("quo", {
      event_id: null,
      message_id: null,
      outcome: verdict === "stale" ? "stale_timestamp" : "rejected_signature",
      routine_status: null,
    });
    return json({ error: "unauthorized" }, 401);
  }

  const record = parseJsonObject(body);
  if (!record) {
    logSource("quo", {
      event_id: null,
      message_id: null,
      outcome: "invalid_payload",
      routine_status: null,
    });
    logShape("quo", body, "invalid_payload");
    return json({ error: "invalid_payload" }, 400);
  }

  const eventType = safeToken(asString(record.type));
  const eventId = safeId(asString(record.id));
  const data = asRecord(record.data);
  // Current Quo (api version 2026-03-30) sends data.resource. Older webhooks send data.object.
  const message = asRecord(data?.object) ?? asRecord(data?.resource);
  const messageId = message ? asString(message.id) : null;
  const loggedMessageId = safeId(messageId);

  if (asString(record.type) !== "message.received") {
    logSource("quo", {
      event_id: eventId,
      message_id: loggedMessageId,
      outcome: "ignored",
      routine_status: null,
      event_type: eventType ?? undefined,
      reason: "event_type",
    });
    logShape("quo", body, "ignored", "event_type");
    return json({ ok: true }, 200);
  }

  if (!message || message.direction !== "incoming") {
    logSource("quo", {
      event_id: eventId,
      message_id: loggedMessageId,
      outcome: "ignored",
      routine_status: null,
      event_type: "message.received",
      reason: "direction",
    });
    logShape("quo", body, "ignored", "direction");
    return json({ ok: true }, 200);
  }

  const context = asRecord(data?.context);
  const line = receivingLine(message.to) ?? receivingLine(context?.recipientIdentifiers);

  if (!messageId) {
    logSource("quo", {
      event_id: eventId,
      message_id: null,
      outcome: "dropped_no_id",
      routine_status: null,
      event_type: "message.received",
    });
    logShape("quo", body, "dropped_no_id");
    return json({ ok: true }, 200);
  }

  const key = `quo:message:${messageId}`;
  let seen: string | null;
  try {
    seen = await env.DEDUPE.get(key);
  } catch {
    logSource("quo", {
      event_id: eventId,
      message_id: loggedMessageId,
      outcome: "dedupe_read_failed",
      routine_status: null,
      event_type: "message.received",
    });
    logShape("quo", body, "dedupe_read_failed");
    return json({ error: "dedupe_unavailable" }, 500);
  }
  if (seen !== null) {
    logSource("quo", {
      event_id: eventId,
      message_id: loggedMessageId,
      outcome: "duplicate",
      routine_status: null,
      event_type: "message.received",
    });
    logShape("quo", body, "duplicate");
    return json({ ok: true }, 200);
  }

  const phone =
    normalizeE164(asString(message.from) ?? "") ??
    normalizeE164(asString(context?.senderIdentifier) ?? "");
  const createdAt =
    asIsoTimestamp(message.createdAt) ?? asIsoTimestamp(record.createdAt) ?? new Date().toISOString();
  const payload = buildRelayMessage({
    source: "quo",
    inbox: line,
    phone,
    firstName: null,
    messageId,
    body: asString(message.body) ?? asString(message.text) ?? "",
    createdAt,
  });
  const queued = await enqueue(env, ctx, [
    {
      key,
      event_id: eventId,
      message_id: loggedMessageId,
      log: { source: "quo", event_type: "message.received" },
      payload,
    },
  ]);
  if (!queued) {
    logShape("quo", body, "queue_failed");
    return json({ error: "queue_unavailable" }, 500);
  }
  logShape("quo", body, null);
  return json({ ok: true }, 200);
}

async function handleWhatsapp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const creds = whatsappCreds(env);
  if (!creds) {
    logSource("whatsapp", {
      event_id: null,
      message_id: null,
      outcome: "dormant",
      routine_status: null,
    });
    return json({ error: "dormant" }, 503);
  }
  if (request.method === "GET") {
    return whatsappHandshake(request, creds.verify);
  }

  const body = await readBoundedBody(request, MAX_BODY_BYTES);
  if (body === null) {
    logSource("whatsapp", {
      event_id: null,
      message_id: null,
      outcome: "payload_too_large",
      routine_status: null,
    });
    return json({ error: "payload_too_large" }, 413);
  }
  const signatureOk = await verifyMetaSignature(
    creds.app,
    body,
    request.headers.get("X-Hub-Signature-256"),
  );
  if (!signatureOk) {
    logSource("whatsapp", {
      event_id: null,
      message_id: null,
      outcome: "rejected_signature",
      routine_status: null,
    });
    return json({ error: "unauthorized" }, 401);
  }

  const record = parseJsonObject(body);
  if (!record) {
    logSource("whatsapp", {
      event_id: null,
      message_id: null,
      outcome: "invalid_payload",
      routine_status: null,
    });
    logShape("whatsapp", body, "invalid_payload");
    return json({ ok: true }, 200);
  }

  // Jobs are queued only after every message passed the dedupe read. If any
  // read fails, the whole batch gets a 500 so Meta redelivers it, and nothing
  // from this request has been queued yet.
  const pending: {
    entryId: string | null;
    messageId: string | null;
    key: string;
    payload: RelayMessage;
  }[] = [];
  const batchKeys = new Set<string>();
  let decisions = 0;
  let sawStatuses = false;
  const entries = Array.isArray(record.entry) ? record.entry : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const entryRecord = entry as Record<string, unknown>;
    const entryId = safeId(asString(entryRecord.id));
    const changes = Array.isArray(entryRecord.changes) ? entryRecord.changes : [];
    for (const change of changes) {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        continue;
      }
      const changeRecord = change as Record<string, unknown>;
      if (changeRecord.field !== "messages") {
        continue;
      }
      const value = changeRecord.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const valueRecord = value as Record<string, unknown>;
      if (Array.isArray(valueRecord.statuses) && valueRecord.statuses.length > 0) {
        sawStatuses = true;
      }
      const messages = Array.isArray(valueRecord.messages) ? valueRecord.messages : [];
      const inbox = nestedString(valueRecord.metadata, "phone_number_id") ?? "";
      for (const item of messages) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }
        decisions += 1;
        const message = item as Record<string, unknown>;
        const messageId = asString(message.id);
        const loggedMessageId = safeId(messageId);
        if (!messageId) {
          logSource("whatsapp", {
            event_id: entryId,
            message_id: null,
            outcome: "dropped_no_id",
            routine_status: null,
            event_type: "messages",
          });
          continue;
        }
        const key = `whatsapp:message:${messageId}`;
        let seen: string | null;
        try {
          seen = batchKeys.has(key) ? "batch" : await env.DEDUPE.get(key);
        } catch {
          logSource("whatsapp", {
            event_id: entryId,
            message_id: loggedMessageId,
            outcome: "dedupe_read_failed",
            routine_status: null,
            event_type: "messages",
          });
          logShape("whatsapp", body, "dedupe_read_failed");
          return json({ error: "dedupe_unavailable" }, 500);
        }
        if (seen !== null) {
          logSource("whatsapp", {
            event_id: entryId,
            message_id: loggedMessageId,
            outcome: "duplicate",
            routine_status: null,
            event_type: "messages",
          });
          continue;
        }
        const from = asString(message.from);
        const phone = from ? normalizeE164(from) : null;
        const type = asString(message.type);
        const media = type === "text" ? null : whatsappMedia(message, type);
        const payload = buildRelayMessage({
          source: "whatsapp",
          inbox,
          phone,
          firstName: contactName(valueRecord.contacts, from),
          messageId,
          body: type === "text" ? (nestedString(message.text, "body") ?? "") : "",
          createdAt: unixToIso(asString(message.timestamp)) ?? new Date().toISOString(),
          mediaType: media?.mediaType ?? null,
          mediaId: media?.mediaId ?? null,
        });
        batchKeys.add(key);
        pending.push({ entryId, messageId: loggedMessageId, key, payload });
      }
    }
  }

  if (pending.length > 0) {
    const queued = await enqueue(
      env,
      ctx,
      pending.map((job) => ({
        key: job.key,
        event_id: job.entryId,
        message_id: job.messageId,
        log: { source: "whatsapp", event_type: "messages" },
        payload: job.payload,
      })),
    );
    if (!queued) {
      logShape("whatsapp", body, "queue_failed");
      return json({ error: "queue_unavailable" }, 500);
    }
    logShape("whatsapp", body, null);
  } else if (decisions === 0) {
    logSource("whatsapp", {
      event_id: null,
      message_id: null,
      outcome: "ignored",
      routine_status: null,
      event_type: "messages",
      ...(sawStatuses ? { reason: "statuses" as const } : {}),
    });
    logShape("whatsapp", body, "ignored", sawStatuses ? "statuses" : null);
  } else {
    logShape("whatsapp", body, null);
  }
  return json({ ok: true }, 200);
}

async function whatsappHandshake(request: Request, verifyToken: string): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const tokenOk = token !== null && (await timingSafeEqualString(token, verifyToken));
  if (mode !== "subscribe" || !tokenOk || challenge === null) {
    logSource("whatsapp", {
      event_id: null,
      message_id: null,
      outcome: "rejected_verify",
      routine_status: null,
    });
    return json({ error: "forbidden" }, 403);
  }
  logSource("whatsapp", {
    event_id: null,
    message_id: null,
    outcome: "verified",
    routine_status: null,
  });
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function whatsappCreds(env: Env): { verify: string; app: string } | null {
  const verify = optionalSecret(env.WHATSAPP_VERIFY_TOKEN);
  const app = optionalSecret(env.WHATSAPP_APP_SECRET);
  if (!verify || !app) {
    return null;
  }
  return { verify, app };
}

function optionalSecret(value: string | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

type QuoSignatureVerdict = "ok" | "bad" | "stale";

const QUO_MAX_SKEW_SECONDS = QUO_MAX_SKEW_MS / 1000;

/**
 * Accept the legacy `openphone-signature` header or the current
 * `webhook-id` / `webhook-timestamp` / `webhook-signature` headers.
 * Either scheme is enough.
 */
async function verifyQuoRequest(
  secret: string,
  body: Uint8Array,
  request: Request,
): Promise<QuoSignatureVerdict> {
  const legacy = await verifyQuoSignature(secret, body, request.headers.get("openphone-signature"));
  if (legacy === "ok") {
    return "ok";
  }
  const current = await verifyQuoCurrentSignature(secret, body, {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  });
  if (current === "ok") {
    return "ok";
  }
  if (legacy === "stale" || current === "stale") {
    return "stale";
  }
  return "bad";
}

/**
 * Current Quo signature, from
 * https://www.quo.com/docs/2026-03-30/webhooks-signature-validation
 *
 * Headers: `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature`
 * (`v1,<base64>` entries separated by spaces).
 * HMAC-SHA256 over `${id}.${timestamp}.` plus the raw body.
 * Key: base64-decode the secret after stripping one leading `whsec_`.
 * Reject when the timestamp is more than 5 minutes from now.
 */
async function verifyQuoCurrentSignature(
  secret: string,
  body: Uint8Array,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
): Promise<QuoSignatureVerdict> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return "bad";
  }
  const keyBytes = decodeBase64(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
  if (!keyBytes) {
    return "bad";
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > QUO_MAX_SKEW_SECONDS) {
    return "stale";
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const mac = await crypto.subtle.sign("HMAC", key, signed);
  const expected = toBase64(mac);
  const provided = signature
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of provided) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) {
      continue;
    }
    if (await timingSafeEqualString(expected, value)) {
      return "ok";
    }
  }
  return "bad";
}

/**
 * Legacy Quo / OpenPhone signature.
 * Header `openphone-signature`: `hmac;1;<timestamp>;<base64>`
 * (comma-separated entries are reserved for more than one signature).
 * HMAC-SHA256 key is the base64-decoded signing secret, with no `whsec_` strip.
 * Signed bytes are `<timestamp>.` plus the raw body.
 * Documented example timestamp `1639710054089` is unix milliseconds.
 * Reject when the timestamp is more than 5 minutes from now.
 */
async function verifyQuoSignature(
  secretB64: string,
  body: Uint8Array,
  header: string | null,
): Promise<QuoSignatureVerdict> {
  if (!header || header.trim().length === 0) {
    return "bad";
  }
  const keyBytes = decodeBase64(secretB64);
  if (!keyBytes) {
    return "bad";
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  let sawStale = false;
  for (const part of header.split(",")) {
    const fields = part.trim().split(";");
    if (fields.length < 4) {
      continue;
    }
    const scheme = fields[0];
    const version = fields[1];
    const timestamp = fields[2];
    const provided = fields.slice(3).join(";");
    if (scheme !== "hmac" || version !== "1" || provided.length === 0 || !timestamp) {
      continue;
    }
    const timestampMs = timestampToMs(timestamp);
    if (timestampMs === null) {
      continue;
    }
    if (Math.abs(Date.now() - timestampMs) > QUO_MAX_SKEW_MS) {
      sawStale = true;
      continue;
    }
    const prefix = new TextEncoder().encode(`${timestamp}.`);
    const signed = new Uint8Array(prefix.length + body.length);
    signed.set(prefix, 0);
    signed.set(body, prefix.length);
    const mac = await crypto.subtle.sign("HMAC", key, signed);
    if (await timingSafeEqualString(toBase64(mac), provided.trim())) {
      return "ok";
    }
  }
  return sawStale ? "stale" : "bad";
}

function timestampToMs(value: string): number | null {
  if (!/^\d{10,13}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return value.length >= 13 ? parsed : parsed * 1000;
}

async function verifyMetaSignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  if (!header || header.trim().length === 0) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, body);
  const expected = `sha256=${toHex(mac)}`;
  return timingSafeEqualString(expected, header.trim().toLowerCase());
}

function decodeBase64(input: string): Uint8Array | null {
  try {
    const binary = atob(input.trim());
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** First E.164 number in a string or array. That is the Quo receiving line. */
function receivingLine(to: unknown): string | null {
  const values = Array.isArray(to) ? to : [to];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const line = normalizeE164(value);
    if (line) {
      return line;
    }
  }
  return null;
}

function buildRelayMessage(fields: {
  source: "quo" | "whatsapp";
  inbox: string | null;
  phone: string | null;
  firstName: string | null;
  messageId: string;
  body: string;
  createdAt: string;
  mediaType?: string | null;
  mediaId?: string | null;
}): RelayMessage {
  const capped = capText(fields.body);
  const sender: RelaySender = {};
  if (fields.phone) {
    sender.phone = fields.phone;
  }
  if (fields.firstName) {
    sender.first_name = fields.firstName;
  }
  const message: RelayMessage = {
    source: fields.source,
    event_type: "message",
    sender,
    message_id: fields.messageId,
    body: capped.text,
    created_at: fields.createdAt,
  };
  if (fields.inbox) {
    message.inbox = fields.inbox;
  }
  if (capped.truncated) {
    message.truncated = true;
  }
  if (fields.mediaType) {
    message.media_type = fields.mediaType;
  }
  if (fields.mediaId) {
    message.media_id = fields.mediaId;
  }
  return message;
}

function capText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_MESSAGE_CHARS) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, MAX_MESSAGE_CHARS), truncated: true };
}

function whatsappMedia(
  message: Record<string, unknown>,
  type: string | null,
): { mediaType: string; mediaId: string | null } | null {
  if (!type || type === "text") {
    return null;
  }
  const nested = message[type];
  const mediaId =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? asString((nested as Record<string, unknown>).id)
      : null;
  return { mediaType: type, mediaId };
}

function contactName(contacts: unknown, from: string | null): string | null {
  if (!Array.isArray(contacts) || !from) {
    return null;
  }
  const target = normalizeE164(from);
  if (!target) {
    return null;
  }
  for (const contact of contacts) {
    if (!contact || typeof contact !== "object" || Array.isArray(contact)) {
      continue;
    }
    const record = contact as Record<string, unknown>;
    const waId = asString(record.wa_id);
    if (!waId || normalizeE164(waId) !== target) {
      continue;
    }
    return nestedString(record.profile, "name");
  }
  return null;
}

function normalizeE164(value: string): string | null {
  const trimmed = value.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{8,15}$/.test(trimmed)) {
    return `+${trimmed}`;
  }
  return null;
}

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return value;
  }
  return null;
}

function unixToIso(value: string | null): string | null {
  if (!value || !/^\d{10,13}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const millis = value.length >= 13 ? parsed : parsed * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function safeId(value: string | null): string | null {
  if (!value || value.length > 200) {
    return null;
  }
  if (!/^[A-Za-z0-9._:=+/_-]+$/.test(value)) {
    return null;
  }
  return value;
}

function safeToken(value: string | null): string | null {
  if (!value || value.length > 80) {
    return null;
  }
  if (!/^[A-Za-z0-9._:]+$/.test(value)) {
    return null;
  }
  return value;
}
