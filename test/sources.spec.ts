import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { network } from "./network";
import { drainQueue, queuedJobs, settle, withQueue } from "./queue";

const PATH_TOKEN = "testpathtoken0123456789abcdefABCDEF";
const ROUTINE_URL = "https://routine.example/hooks/guest";
const AUTH = "Bearer routine-test-token";
const HOSPITABLE_IP = "38.80.170.10";
const QUO_SECRET = btoa("quo-test-signing-secret");
const WA_VERIFY = "wa-verify-token";
const WA_APP = "wa-app-secret";
const OTHER_GUEST = "+15555550102";
const CABIN_LINE = "+15555550100";
const SHARED_LINE = "+15555550101";
const GUEST_PHONE = "+15555550103";
const ANY_LINE = "+15555550999";
const BODY_CANARY = "QUO-BODY-CANARY-do-not-log";
const WA_BODY = "WA-BODY-CANARY-do-not-log";
const WA_NAME = "Nala Private";
const WA_CAPTION = "WA-CAPTION-CANARY-do-not-log";
const RELAY = "guest-messaging-relay";

interface Captured {
  count: number;
  bodies: unknown[];
}

function captureRoutine(): Captured {
  const captured: Captured = { count: 0, bodies: [] };
  network.use(
    http.post(ROUTINE_URL, async ({ request }) => {
      captured.count += 1;
      captured.bodies.push(await request.json());
      return HttpResponse.json({ ok: true });
    }),
  );
  return captured;
}

function baseEnv(extra: Partial<Env> = {}): Env {
  return withQueue({
    DEDUPE: env.DEDUPE,
    RELAY_PATH_TOKEN: env.RELAY_PATH_TOKEN,
    RESPONDER_WEBHOOK_URL: env.RESPONDER_WEBHOOK_URL,
    RESPONDER_AUTH_HEADER: env.RESPONDER_AUTH_HEADER,
    ENFORCE_HOSPITABLE_IP: env.ENFORCE_HOSPITABLE_IP,
    QUO_WEBHOOK_SECRET: QUO_SECRET,
    WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    WHATSAPP_APP_SECRET: WA_APP,
    ...extra,
  });
}

async function clearDedupe(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.DEDUPE.list({ cursor });
    await Promise.all(page.keys.map((key) => env.DEDUPE.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message));
  });
  const error = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    lines.push(String(message));
  });
  return {
    lines,
    restore() {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

/** Status lines only. The temporary payload_shape line is asserted on its own. */
function jsonLogs(lines: string[]): Record<string, unknown>[] {
  return lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.diag !== "payload_shape");
}

async function hmacBase64(keyBytes: Uint8Array, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, data);
  let binary = "";
  for (const byte of new Uint8Array(mac)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function quoCurrentHeaders(
  raw: string,
  secret = `whsec_${QUO_SECRET}`,
  timestamp = Math.floor(Date.now() / 1000),
  id = "msg_current",
): Promise<Record<string, string>> {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const body = new TextEncoder().encode(raw);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const sig = await hmacBase64(decodeBase64(encoded), signed);
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v0,bm90LXYz v1,${sig}`,
  };
}

async function quoHeader(raw: string, secret = QUO_SECRET, timestamp = Date.now()): Promise<string> {
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const body = new TextEncoder().encode(raw);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const sig = await hmacBase64(decodeBase64(secret), signed);
  return `hmac;1;${timestamp};${sig}`;
}

async function metaHeader(raw: string, secret = WA_APP): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function post(
  url: string,
  raw: string,
  headers: Record<string, string>,
  testEnv: Env = baseEnv(),
): Promise<{ response: Response; ctx: ExecutionContext }> {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  }) as Request<unknown, IncomingRequestCfProperties>;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  return { response, ctx };
}

function quoUrl(): string {
  return `https://relay.example/hook/${PATH_TOKEN}/quo`;
}

function whatsappUrl(): string {
  return `https://relay.example/hook/${PATH_TOKEN}/whatsapp`;
}

const CURRENT_TEXT = "CURRENT-TEXT-CANARY-do-not-log";
const QUO_LINK = "https://example.com/inbox/fake";
const RESOURCE_AT = "2026-04-13T12:00:00.000Z";
const ENVELOPE_AT = "2026-04-13T11:00:00.000Z";

function currentContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgId: "OR-fake",
    phoneNumberId: "PN-fake",
    conversationId: "CN-fake",
    userId: "US-fake",
    contacts: { ids: ["CT-fake"], lookupStatus: "matched" },
    senderIdentifier: GUEST_PHONE,
    recipientIdentifiers: [CABIN_LINE],
    ...extra,
  };
}

/** Observed Quo api version 2026-03-30 shape, with fake values. */
function currentQuoEvent(overrides: {
  type?: string;
  direction?: string;
  status?: string;
  id?: string;
  eventId?: string;
  text?: string;
  omitText?: boolean;
  omitResourceCreatedAt?: boolean;
  context?: unknown;
} = {}): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    id: overrides.id ?? "AC-current-1",
    direction: overrides.direction ?? "incoming",
    media: [],
    status: overrides.status ?? "received",
    createdAt: RESOURCE_AT,
  };
  if (!overrides.omitText) {
    resource.text = overrides.text ?? CURRENT_TEXT;
  }
  if (overrides.omitResourceCreatedAt) {
    delete resource.createdAt;
  }
  return {
    id: overrides.eventId ?? "EV-current-1",
    apiVersion: "2026-03-30",
    createdAt: ENVELOPE_AT,
    type: overrides.type ?? "message.received",
    data: {
      resource,
      context: overrides.context === undefined ? currentContext() : overrides.context,
      links: { quo: QUO_LINK },
    },
  };
}

function quoEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const objectOverrides =
    overrides.object && typeof overrides.object === "object" && !Array.isArray(overrides.object)
      ? (overrides.object as Record<string, unknown>)
      : {};
  const { object: _object, ...rest } = overrides;
  return {
    id: "EV-quo-1",
    object: "event",
    apiVersion: "v2",
    createdAt: "2022-01-23T16:55:52.557Z",
    type: "message.received",
    ...rest,
    data: {
      object: {
        id: "AC-quo-1",
        object: "message",
        from: GUEST_PHONE,
        to: CABIN_LINE,
        direction: "incoming",
        body: BODY_CANARY,
        status: "received",
        createdAt: "2022-01-23T16:55:52.420Z",
        ...objectOverrides,
      },
    },
  };
}

describe("quo and whatsapp sources", () => {
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    await clearDedupe();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it("forwards an incoming Quo message on the configured cabin line", async () => {
    const captured = captureRoutine();
    const event = quoEvent();
    const raw = JSON.stringify(event);
    const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) }, baseEnv());
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toEqual({
      source: "quo",
      event_type: "message",
      inbox: CABIN_LINE,
      sender: { phone: GUEST_PHONE },
      message_id: "AC-quo-1",
      body: BODY_CANARY,
      created_at: "2022-01-23T16:55:52.420Z",
    });
    expect(await env.DEDUPE.get("quo:message:AC-quo-1")).toBe("1");
    const logged = logs.lines.join("\n");
    expect(logged).toContain(RELAY);
    expect(logged).not.toContain("guest-message-relay");
    expect(logged).not.toContain(BODY_CANARY);
    expect(logged).not.toContain(GUEST_PHONE);
    expect(logged).not.toContain(CABIN_LINE);
    expect(logged).not.toContain(QUO_SECRET);
    expect(jsonLogs(logs.lines)).toContainEqual({
      relay: RELAY,
      source: "quo",
      event_id: "EV-quo-1",
      message_id: "AC-quo-1",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      event_type: "message.received",
    });
  });

  it("accepts a good Quo signature, rejects a bad one, and rejects a stale timestamp", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(quoEvent({ id: "EV-sig", object: { id: "AC-sig" } }));
    const good = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) });
    expect(good.response.status).toBe(200);
    await settle(good.ctx);

    const bad = await post(quoUrl(), raw, {
      "openphone-signature": `hmac;1;${Date.now()};AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
    });
    expect(bad.response.status).toBe(401);
    expect(await bad.response.json()).toEqual({ error: "unauthorized" });
    await settle(bad.ctx);

    const staleTs = Date.now() - 6 * 60 * 1000;
    const stale = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw, QUO_SECRET, staleTs) });
    expect(stale.response.status).toBe(401);
    await settle(stale.ctx);

    const futureTs = Date.now() + 6 * 60 * 1000;
    const future = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw, QUO_SECRET, futureTs) });
    expect(future.response.status).toBe(401);
    await settle(future.ctx);

    expect(captured.count).toBe(1);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual([
      "forwarded",
      "rejected_signature",
      "stale_timestamp",
      "stale_timestamp",
    ]);
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
  });

  it("accepts a good current-scheme Quo signature and rejects a bad or stale one", async () => {
    const captured = captureRoutine();
    const secret = `whsec_${QUO_SECRET}`;
    const testEnv = baseEnv({ QUO_WEBHOOK_SECRET: secret });
    const raw = JSON.stringify(quoEvent({ id: "EV-current", object: { id: "AC-current" } }));
    const good = await post(quoUrl(), raw, await quoCurrentHeaders(raw, secret, Math.floor(Date.now() / 1000), "msg_good"), testEnv);
    expect(good.response.status).toBe(200);
    await settle(good.ctx);
    expect(captured.bodies[0]).toMatchObject({
      source: "quo",
      event_type: "message",
      message_id: "AC-current",
      body: BODY_CANARY,
    });

    const badTimestamp = String(Math.floor(Date.now() / 1000));
    const bad = await post(
      quoUrl(),
      raw,
      {
        "webhook-id": "msg_bad",
        "webhook-timestamp": badTimestamp,
        "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      testEnv,
    );
    expect(bad.response.status).toBe(401);
    expect(await bad.response.json()).toEqual({ error: "unauthorized" });
    await settle(bad.ctx);

    const staleTimestamp = Math.floor(Date.now() / 1000) - 6 * 60;
    const stale = await post(
      quoUrl(),
      raw,
      await quoCurrentHeaders(raw, secret, staleTimestamp, "msg_stale"),
      testEnv,
    );
    expect(stale.response.status).toBe(401);
    await settle(stale.ctx);

    const futureTimestamp = Math.floor(Date.now() / 1000) + 6 * 60;
    const future = await post(
      quoUrl(),
      raw,
      await quoCurrentHeaders(raw, secret, futureTimestamp, "msg_future"),
      testEnv,
    );
    expect(future.response.status).toBe(401);
    await settle(future.ctx);

    expect(captured.count).toBe(1);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual([
      "forwarded",
      "rejected_signature",
      "stale_timestamp",
      "stale_timestamp",
    ]);
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
    expect(logs.lines.join("\n")).not.toContain(secret);
  });

  it("matches the documented current Quo HMAC vector and still accepts a bare base64 secret", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_710_000_000_000);
    try {
      const raw = '{"id":"evt-current","type":"message.received"}';
      const { response, ctx } = await post(
        quoUrl(),
        raw,
        {
          "webhook-id": "msg_2Kp9",
          "webhook-timestamp": "1710000000",
          "webhook-signature": "v1,8SyEgx7j0o52yt8/aka9SdTsO93xy1b4Pelt8Rr8/M0=",
          "openphone-signature": "hmac;1;1710000000000;not-a-legacy-signature",
        },
        baseEnv({ QUO_WEBHOOK_SECRET: `whsec_${QUO_SECRET}` }),
      );
      expect(response.status).toBe(200);
      await settle(ctx);
      expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["ignored"]);
    } finally {
      now.mockRestore();
    }

    const captured = captureRoutine();
    const raw = JSON.stringify(quoEvent({ id: "EV-bare", object: { id: "AC-bare" } }));
    const bare = await post(quoUrl(), raw, await quoCurrentHeaders(raw, QUO_SECRET, Math.floor(Date.now() / 1000), "msg_bare"));
    expect(bare.response.status).toBe(200);
    await settle(bare.ctx);
    expect(captured.count).toBe(1);
  });

  it("matches the documented OpenPhone HMAC vector, including a key with a high byte", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_639_710_054_089);
    try {
      const secret = "R2ZLM2o0bFhBNVpyUnU2NG9mYXQ1MHNyR3pvSUhIVVg=";
      const raw = '{"id":"evt-vector","type":"message.received"}';
      const header = "hmac;1;1639710054089;veBvvn+W2EhfyLGP8dENhzAf0K4s7s3D2HDxvR/1AkY=";
      const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": header }, baseEnv({ QUO_WEBHOOK_SECRET: secret }));
      expect(response.status).toBe(200);
      await settle(ctx);
      expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["ignored"]);
    } finally {
      now.mockRestore();
    }

    const highNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const raw = '{"n":1}';
      const header = "hmac;1;1700000000000;CUmdegqpCqp7lur9wP9RWRx8vo1toFociS/ymnX2fOU=";
      const { response, ctx } = await post(
        quoUrl(),
        raw,
        { "openphone-signature": header },
        baseEnv({ QUO_WEBHOOK_SECRET: "AP8QgH9B" }),
      );
      expect(response.status).toBe(200);
      await settle(ctx);
    } finally {
      highNow.mockRestore();
    }
    expect(logs.lines.join("\n")).not.toContain("rejected_signature");
  });

  it("accepts a comma-separated Quo signature when one entry is valid", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(quoEvent({ id: "EV-multi", object: { id: "AC-multi" } }));
    const header = `hmac;1;${Date.now()};not-the-signature,${await quoHeader(raw)}`;
    const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": header });
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
  });

  it("ignores outbound Quo events and other event types, and forwards any incoming line", async () => {
    const captured = captureRoutine();
    const ignored = [
      quoEvent({ id: "EV-out", object: { id: "AC-out", direction: "outgoing", from: CABIN_LINE, to: GUEST_PHONE } }),
      quoEvent({ id: "EV-delivered", type: "message.delivered", object: { id: "AC-delivered", direction: "outgoing" } }),
      quoEvent({ id: "EV-call", type: "call.ringing", object: { id: "AC-call", direction: "incoming", to: CABIN_LINE } }),
    ];
    for (const event of ignored) {
      const raw = JSON.stringify(event);
      const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) });
      expect(response.status).toBe(200);
      await settle(ctx);
    }
    const raw = JSON.stringify(quoEvent({ id: "EV-any", object: { id: "AC-any", to: ANY_LINE } }));
    const forwarded = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) });
    expect(forwarded.response.status).toBe(200);
    await settle(forwarded.ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toMatchObject({
      source: "quo",
      inbox: ANY_LINE,
      message_id: "AC-any",
    });
    expect(captured.bodies[0]).not.toHaveProperty("property");
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "forwarded",
    ]);
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
    expect(logs.lines.join("\n")).not.toContain(GUEST_PHONE);
    expect(logs.lines.join("\n")).not.toContain(ANY_LINE);
  });

  it("forwards every incoming Quo line", async () => {
    const captured = captureRoutine();
    const cabinRaw = JSON.stringify(
      quoEvent({
        id: "EV-cabin",
        object: { id: "AC-cabin", from: OTHER_GUEST, to: CABIN_LINE, body: "cabin text " + BODY_CANARY },
      }),
    );
    const cabin = await post(quoUrl(), cabinRaw, { "openphone-signature": await quoHeader(cabinRaw) });
    expect(cabin.response.status).toBe(200);
    await settle(cabin.ctx);

    const sharedRaw = JSON.stringify(
      quoEvent({
        id: "EV-shared",
        object: { id: "AC-shared", to: SHARED_LINE, body: "shared " + BODY_CANARY },
      }),
    );
    const shared = await post(quoUrl(), sharedRaw, { "openphone-signature": await quoHeader(sharedRaw) });
    expect(shared.response.status).toBe(200);
    await settle(shared.ctx);

    expect(captured.bodies[0]).toMatchObject({
      source: "quo",
      inbox: CABIN_LINE,
      sender: { phone: OTHER_GUEST },
    });
    expect(captured.bodies[0]).not.toHaveProperty("property");
    expect(captured.bodies[1]).toEqual({
      source: "quo",
      event_type: "message",
      inbox: SHARED_LINE,
      sender: { phone: GUEST_PHONE },
      message_id: "AC-shared",
      body: "shared " + BODY_CANARY,
      created_at: "2022-01-23T16:55:52.420Z",
    });
    const logged = logs.lines.join("\n");
    expect(logged).not.toContain(OTHER_GUEST);
    expect(logged).not.toContain(BODY_CANARY);
    expect(logged).not.toContain("cabin text");
  });

  it("caps Quo bodies at 4000 characters", async () => {
    const captured = captureRoutine();
    const body = `${"B".repeat(3990)}UNIQUE-TAIL-ZZ`;
    const raw = JSON.stringify(quoEvent({ id: "EV-long", object: { id: "AC-long", body } }));
    const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) });
    expect(response.status).toBe(200);
    await settle(ctx);
    const forwarded = captured.bodies[0] as { body: string; truncated?: boolean };
    expect(forwarded.body).toHaveLength(4000);
    expect(forwarded.truncated).toBe(true);
    expect(forwarded.body).not.toContain("UNIQUE-TAIL-ZZ");
    expect(logs.lines.join("\n")).not.toContain("UNIQUE-TAIL-ZZ");
    expect(logs.lines.join("\n")).not.toContain("BBBBBBBBBB");
  });

  it("returns 503 for Quo when the signing secret is unset and 404 for a bad token", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(quoEvent());
    const dormant = await post(quoUrl(), raw, {}, baseEnv({ QUO_WEBHOOK_SECRET: undefined }));
    expect(dormant.response.status).toBe(503);
    expect(await dormant.response.json()).toEqual({ error: "dormant" });
    await settle(dormant.ctx);

    const wrong = await post(
      "https://relay.example/hook/wrong-token/quo",
      raw,
      { "openphone-signature": await quoHeader(raw) },
    );
    expect(wrong.response.status).toBe(404);
    await settle(wrong.ctx);

    const get = await worker.fetch(new Request(quoUrl(), { method: "GET" }), baseEnv(), createExecutionContext());
    expect(get.status).toBe(404);
    expect(captured.count).toBe(0);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toContain("dormant");
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
  });

  it("does not apply the Hospitable IP allowlist to Quo", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(quoEvent({ id: "EV-ip", object: { id: "AC-ip" } }));
    const request = new Request(quoUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "openphone-signature": await quoHeader(raw),
        "CF-Connecting-IP": "203.0.113.8",
      },
      body: raw,
    }) as Request<unknown, IncomingRequestCfProperties>;
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, baseEnv(), ctx);
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
  });

  it("normalizes a current Quo message.received and keeps the legacy object when both are present", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(currentQuoEvent());
    const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await settle(ctx);
    expect(captured.bodies[0]).toEqual({
      source: "quo",
      event_type: "message",
      inbox: CABIN_LINE,
      sender: { phone: GUEST_PHONE },
      message_id: "AC-current-1",
      body: CURRENT_TEXT,
      created_at: RESOURCE_AT,
    });
    expect(await env.DEDUPE.get("quo:message:AC-current-1")).toBe("1");
    const again = JSON.stringify(currentQuoEvent({ eventId: "EV-current-retry" }));
    const duplicate = await post(quoUrl(), again, { "openphone-signature": await quoHeader(again) });
    expect(duplicate.response.status).toBe(200);
    await settle(duplicate.ctx);
    expect(captured.count).toBe(1);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["forwarded", "duplicate"]);

    const mixed = quoEvent({ id: "EV-both", object: { id: "AC-legacy-wins" } });
    const mixedData = mixed.data as Record<string, unknown>;
    mixedData.resource = {
      id: "AC-current-loses",
      direction: "incoming",
      text: CURRENT_TEXT,
      media: [],
      status: "received",
      createdAt: RESOURCE_AT,
    };
    mixedData.context = currentContext({
      senderIdentifier: OTHER_GUEST,
      recipientIdentifiers: [SHARED_LINE],
    });
    mixedData.links = { quo: QUO_LINK };
    const mixedRaw = JSON.stringify(mixed);
    const legacy = await post(quoUrl(), mixedRaw, { "openphone-signature": await quoHeader(mixedRaw) });
    expect(legacy.response.status).toBe(200);
    await settle(legacy.ctx);
    expect(captured.bodies[1]).toEqual({
      source: "quo",
      event_type: "message",
      inbox: CABIN_LINE,
      sender: { phone: GUEST_PHONE },
      message_id: "AC-legacy-wins",
      body: BODY_CANARY,
      created_at: "2022-01-23T16:55:52.420Z",
    });

    const logged = logs.lines.join("\n");
    for (const secret of [CURRENT_TEXT, BODY_CANARY, QUO_LINK, GUEST_PHONE, CABIN_LINE, OTHER_GUEST, "OR-fake", "CT-fake", "US-fake", "CN-fake", "PN-fake"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("rejects a current Quo payload with a bad signature and ignores outgoing or other events", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(currentQuoEvent({ eventId: "EV-current-sig", id: "AC-current-sig" }));
    const bad = await post(quoUrl(), raw, { "openphone-signature": "hmac;1;1;not-a-signature" });
    expect(bad.response.status).toBe(401);
    expect(await bad.response.json()).toEqual({ error: "unauthorized" });
    await settle(bad.ctx);

    const delivered = JSON.stringify(
      currentQuoEvent({
        eventId: "EV-delivered-current",
        id: "AC-delivered-current",
        type: "message.delivered",
        direction: "outgoing",
        status: "delivered",
        text: "DELIVERED-TEXT-CANARY",
      }),
    );
    const deliveredPost = await post(quoUrl(), delivered, { "openphone-signature": await quoHeader(delivered) });
    expect(deliveredPost.response.status).toBe(200);
    await settle(deliveredPost.ctx);

    const outgoing = JSON.stringify(
      currentQuoEvent({
        eventId: "EV-outgoing-current",
        id: "AC-outgoing-current",
        direction: "outgoing",
        text: "OUTGOING-TEXT-CANARY",
      }),
    );
    const outgoingPost = await post(quoUrl(), outgoing, { "openphone-signature": await quoHeader(outgoing) });
    expect(outgoingPost.response.status).toBe(200);
    await settle(outgoingPost.ctx);

    const other = JSON.stringify(
      currentQuoEvent({
        eventId: "EV-call-current",
        id: "AC-call-current",
        type: "call.ringing",
        direction: "incoming",
      }),
    );
    const otherPost = await post(quoUrl(), other, { "openphone-signature": await quoHeader(other) });
    expect(otherPost.response.status).toBe(200);
    await settle(otherPost.ctx);

    expect(captured.count).toBe(0);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual([
      "rejected_signature",
      "ignored",
      "ignored",
      "ignored",
    ]);
    expect(jsonLogs(logs.lines).filter((entry) => entry.outcome === "ignored").map((entry) => entry.reason)).toEqual([
      "event_type",
      "direction",
      "event_type",
    ]);
    const logged = logs.lines.join("\n");
    expect(logged).not.toContain(CURRENT_TEXT);
    expect(logged).not.toContain("DELIVERED-TEXT-CANARY");
    expect(logged).not.toContain("OUTGOING-TEXT-CANARY");
    expect(logged).not.toContain(GUEST_PHONE);
    expect(logged).not.toContain(QUO_LINK);
  });

  it("forwards a current message when context is missing or unusable, and skips non-numbers", async () => {
    const captured = captureRoutine();
    const missingRaw = JSON.stringify(
      currentQuoEvent({ eventId: "EV-no-context", id: "AC-no-context", context: null, omitResourceCreatedAt: true }),
    );
    const missing = await post(quoUrl(), missingRaw, { "openphone-signature": await quoHeader(missingRaw) });
    expect(missing.response.status).toBe(200);
    await settle(missing.ctx);
    expect(captured.bodies[0]).toEqual({
      source: "quo",
      event_type: "message",
      sender: {},
      message_id: "AC-no-context",
      body: CURRENT_TEXT,
      created_at: ENVELOPE_AT,
    });

    const brokenRaw = JSON.stringify(
      currentQuoEvent({
        eventId: "EV-bad-context",
        id: "AC-bad-context",
        context: { senderIdentifier: "Ada Guest", recipientIdentifiers: [1, "nope", { n: 1 }], phoneNumberId: "PN-fake" },
      }),
    );
    const broken = await post(quoUrl(), brokenRaw, { "openphone-signature": await quoHeader(brokenRaw) });
    expect(broken.response.status).toBe(200);
    await settle(broken.ctx);
    expect(captured.bodies[1]).toEqual({
      source: "quo",
      event_type: "message",
      sender: {},
      message_id: "AC-bad-context",
      body: CURRENT_TEXT,
      created_at: RESOURCE_AT,
    });

    const pickedRaw = JSON.stringify(
      currentQuoEvent({
        eventId: "EV-pick-line",
        id: "AC-pick-line",
        context: currentContext({
          recipientIdentifiers: ["PN-fake", "not-a-phone", SHARED_LINE, ANY_LINE],
        }),
      }),
    );
    const picked = await post(quoUrl(), pickedRaw, { "openphone-signature": await quoHeader(pickedRaw) });
    expect(picked.response.status).toBe(200);
    await settle(picked.ctx);
    expect(captured.bodies[2]).toMatchObject({
      inbox: SHARED_LINE,
      sender: { phone: GUEST_PHONE },
      message_id: "AC-pick-line",
    });

    const noIdRaw = JSON.stringify(currentQuoEvent({ eventId: "EV-no-id", id: "", omitText: true }));
    const noId = await post(quoUrl(), noIdRaw, { "openphone-signature": await quoHeader(noIdRaw) });
    expect(noId.response.status).toBe(200);
    await settle(noId.ctx);

    expect(captured.count).toBe(3);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toContain("dropped_no_id");
    const logged = logs.lines.join("\n");
    expect(logged).not.toContain(CURRENT_TEXT);
    expect(logged).not.toContain("Ada Guest");
    expect(logged).not.toContain(QUO_LINK);
    expect(logged).not.toContain(SHARED_LINE);
    expect(logged).not.toContain("PN-fake");
  });

  it("keeps POST /hook/<token>/hospitable on the Hospitable source", async () => {
    const captured = captureRoutine();
    const event = {
      id: "evt-alias",
      action: "message.created",
      data: {
        id: "msg-alias",
        sender_type: "guest",
        source: "platform",
        body: "alias body",
        created_at: "2024-10-08T07:03:34Z",
        property: { id: "prop-ww", name: "Example Cabin" },
        sender: { first_name: "Ada" },
        phone: OTHER_GUEST,
      },
    };
    const raw = JSON.stringify(event);
    const outside = await post(
      `https://relay.example/hook/${PATH_TOKEN}/hospitable`,
      raw,
      { "CF-Connecting-IP": "203.0.113.9" },
    );
    expect(outside.response.status).toBe(401);
    await settle(outside.ctx);

    const inside = await post(
      `https://relay.example/hook/${PATH_TOKEN}/hospitable`,
      raw,
      { "CF-Connecting-IP": HOSPITABLE_IP },
    );
    expect(inside.response.status).toBe(200);
    await settle(inside.ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toMatchObject({
      event_type: "message.created",
      source: "hospitable",
      inbox: "hospitable",
      property_name: "Example Cabin",
      property: "Example Cabin",
      sender: { first_name: "Ada" },
      body: "alias body",
    });
    const forwarded = JSON.stringify(captured.bodies[0]);
    expect(forwarded).not.toContain(OTHER_GUEST);
    expect(logs.lines.join("\n")).not.toContain("alias body");
    expect(logs.lines.join("\n")).not.toContain(OTHER_GUEST);
    expect(logs.lines.join("\n")).not.toContain("Ada");
  });

  it("passes a Hospitable property name through, including Example Lodge", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify({
      id: "evt-phx",
      action: "message.created",
      data: {
        id: "msg-phx",
        sender_type: "guest",
        body: "hello",
        property: { name: "Example Lodge" },
      },
    });
    const { response, ctx } = await post(
      `https://relay.example/hook/${PATH_TOKEN}`,
      raw,
      { "CF-Connecting-IP": HOSPITABLE_IP },
      baseEnv(),
    );
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.bodies[0]).toMatchObject({
      property_name: "Example Lodge",
      property: "Example Lodge",
      source: "hospitable",
    });
  });

  it("completes the WhatsApp verify handshake and rejects a bad token", async () => {
    const okUrl = `${whatsappUrl()}?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=challenge-token-9`;
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(okUrl, { method: "GET" }), baseEnv(), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("challenge-token-9");
    await settle(ctx);

    const badUrl = `${whatsappUrl()}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=challenge-token-9`;
    const badCtx = createExecutionContext();
    const bad = await worker.fetch(new Request(badUrl, { method: "GET" }), baseEnv(), badCtx);
    expect(bad.status).toBe(403);
    await settle(badCtx);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["verified", "rejected_verify"]);
    expect(logs.lines.join("\n")).not.toContain(WA_VERIFY);
    expect(logs.lines.join("\n")).not.toContain("challenge-token-9");
  });

  it("forwards a WhatsApp text, a media pointer, and ignores statuses", async () => {
    const captured = captureRoutine();
    const text = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN-100", display_phone_number: "15555550101" },
                contacts: [{ wa_id: "15555550104", profile: { name: WA_NAME } }],
                messages: [
                  {
                    from: "15555550104",
                    id: "wamid.text",
                    timestamp: "1710000000",
                    type: "text",
                    text: { body: WA_BODY },
                  },
                ],
                statuses: [{ id: "wamid.out", status: "delivered", recipient_id: "15555550104" }],
              },
            },
          ],
        },
      ],
    };
    const textRaw = JSON.stringify(text);
    const textPost = await post(whatsappUrl(), textRaw, { "X-Hub-Signature-256": await metaHeader(textRaw) });
    expect(textPost.response.status).toBe(200);
    await settle(textPost.ctx);

    const media = {
      entry: [
        {
          id: "entry-2",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN-100" },
                contacts: [{ wa_id: "15555550102", profile: { name: WA_NAME } }],
                messages: [
                  {
                    from: "15555550102",
                    id: "wamid.img",
                    timestamp: "1710000001",
                    type: "image",
                    image: { id: "media-9", mime_type: "image/jpeg", caption: WA_CAPTION },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const mediaRaw = JSON.stringify(media);
    const mediaPost = await post(whatsappUrl(), mediaRaw, { "X-Hub-Signature-256": await metaHeader(mediaRaw) });
    expect(mediaPost.response.status).toBe(200);
    await settle(mediaPost.ctx);

    const statuses = {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [{ id: "wamid.status", status: "read", recipient_id: "15555550104" }],
              },
            },
          ],
        },
      ],
    };
    const statusRaw = JSON.stringify(statuses);
    const statusPost = await post(whatsappUrl(), statusRaw, { "X-Hub-Signature-256": await metaHeader(statusRaw) });
    expect(statusPost.response.status).toBe(200);
    await settle(statusPost.ctx);

    expect(captured.count).toBe(2);
    expect(captured.bodies[0]).toEqual({
      source: "whatsapp",
      event_type: "message",
      inbox: "PN-100",
      sender: { phone: "+15555550104", first_name: WA_NAME },
      message_id: "wamid.text",
      body: WA_BODY,
      created_at: new Date(1710000000 * 1000).toISOString(),
    });
    expect(captured.bodies[1]).toEqual({
      source: "whatsapp",
      event_type: "message",
      inbox: "PN-100",
      sender: { phone: OTHER_GUEST, first_name: WA_NAME },
      message_id: "wamid.img",
      body: "",
      created_at: new Date(1710000001 * 1000).toISOString(),
      media_type: "image",
      media_id: "media-9",
    });
    const forwarded = JSON.stringify(captured.bodies);
    expect(forwarded).not.toContain(WA_CAPTION);
    expect(forwarded).not.toContain("wamid.status");
    expect(forwarded).not.toContain("wamid.out");
    const logged = logs.lines.join("\n");
    expect(logged).not.toContain(WA_BODY);
    expect(logged).not.toContain(WA_NAME);
    expect(logged).not.toContain(WA_CAPTION);
    expect(logged).not.toContain("15555550104");
    expect(logged).not.toContain(OTHER_GUEST);
    expect(logged).not.toContain(WA_APP);
    expect(jsonLogs(logs.lines).some((entry) => entry.reason === "statuses")).toBe(true);
  });

  it("rejects a bad WhatsApp signature and stays dormant until both secrets are set", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify({ entry: [] });
    const bad = await post(whatsappUrl(), raw, { "X-Hub-Signature-256": "sha256=deadbeef" });
    expect(bad.response.status).toBe(401);
    await settle(bad.ctx);

    const missingApp = baseEnv({ WHATSAPP_APP_SECRET: "" });
    const postDormant = await post(whatsappUrl(), raw, {}, missingApp);
    expect(postDormant.response.status).toBe(503);
    await settle(postDormant.ctx);

    const getCtx = createExecutionContext();
    const getDormant = await worker.fetch(
      new Request(`${whatsappUrl()}?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=x`),
      baseEnv({ WHATSAPP_VERIFY_TOKEN: undefined }),
      getCtx,
    );
    expect(getDormant.status).toBe(503);
    expect(await getDormant.json()).toEqual({ error: "dormant" });
    await settle(getCtx);
    expect(captured.count).toBe(0);
    expect(logs.lines.join("\n")).not.toContain("deadbeef");
  });

  it("returns 500 and forwards nothing when a WhatsApp dedupe read fails", async () => {
    const captured = captureRoutine();
    const batch = {
      entry: [
        {
          id: "entry-kv",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN-100" },
                messages: [
                  { from: "15555550104", id: "wamid.kv-1", timestamp: "1710000000", type: "text", text: { body: WA_BODY } },
                  { from: "15555550104", id: "wamid.kv-2", timestamp: "1710000001", type: "text", text: { body: WA_BODY } },
                ],
              },
            },
          ],
        },
      ],
    };
    let reads = 0;
    const flakyKv = {
      get: async (key: string) => {
        reads += 1;
        if (reads === 2) {
          throw new Error("kv down");
        }
        return env.DEDUPE.get(key);
      },
      put: env.DEDUPE.put.bind(env.DEDUPE),
    } as unknown as KVNamespace;
    const raw = JSON.stringify(batch);
    const { response, ctx } = await post(
      whatsappUrl(),
      raw,
      { "X-Hub-Signature-256": await metaHeader(raw) },
      baseEnv({ DEDUPE: flakyKv }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "dedupe_unavailable" });
    await settle(ctx);
    expect(captured.count).toBe(0);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["dedupe_read_failed"]);
    expect(await env.DEDUPE.get("whatsapp:message:wamid.kv-1")).toBeNull();
    expect(logs.lines.join("\n")).not.toContain(WA_BODY);
  });

  it("forwards a WhatsApp message id repeated within one batch only once", async () => {
    const captured = captureRoutine();
    const message = { from: "15555550104", id: "wamid.twice", timestamp: "1710000000", type: "text", text: { body: WA_BODY } };
    const raw = JSON.stringify({
      entry: [
        {
          id: "entry-twice",
          changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN-100" }, messages: [message, message] } }],
        },
      ],
    });
    const { response, ctx } = await post(whatsappUrl(), raw, { "X-Hub-Signature-256": await metaHeader(raw) });
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome).sort()).toEqual(["duplicate", "forwarded"]);
  });

  it("returns 404 for unknown routes", async () => {
    const raw = "{}";
    const extra = await post(`https://relay.example/hook/${PATH_TOKEN}/extra`, raw, {});
    expect(extra.response.status).toBe(404);
    await settle(extra.ctx);
    const other = await post("https://relay.example/quo", raw, {});
    expect(other.response.status).toBe(404);
    await settle(other.ctx);
  });
});
