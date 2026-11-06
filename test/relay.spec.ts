import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DEDUPE_TTL_SECONDS, MAX_DELIVERY_RETRIES, retryDelaySeconds } from "../src/lib";
import { network } from "./network";
import { drainQueue, queuedJobs, settle, withQueue } from "./queue";

const SECRET = "test-webhook-secret";
const PATH_TOKEN = "testpathtoken0123456789abcdefABCDEF";
const ROUTINE_URL = "https://routine.example/hooks/guest";
const AUTH = "Bearer routine-test-token";
const HOSPITABLE_IP = "38.80.170.10";
const HOOK_URL = `https://relay.example/hook/${PATH_TOKEN}`;

const BODY_CANARY = "SECRET-BODY-do-not-forward";
const EMAIL_CANARY = "guest@secret.example";
const PHONE_CANARY = "+15551230000";
const NAME_CANARY = "Jane Secret";
const STREET_CANARY = "742 Secret Evergreen Terrace";
const COORD_CANARY = "30.267201";
const DESCRIPTION_CANARY = "SECRET-DESCRIPTION-do-not-forward";
const SUMMARY_CANARY = "SECRET-SUMMARY-do-not-forward";
const PICTURE_CANARY = "https://cdn.example/secret-house.jpg";

const ALLOWED_KEYS = [
  "event_type",
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
  "source",
  "inbox",
  "sender",
  "property",
] as const;

interface Captured {
  count: number;
  bodies: unknown[];
  authorizations: string[];
  contentTypes: string[];
}

function captureRoutine(handler?: () => Response | Promise<Response>): Captured {
  const captured: Captured = {
    count: 0,
    bodies: [],
    authorizations: [],
    contentTypes: [],
  };
  network.use(
    http.post(ROUTINE_URL, async ({ request }) => {
      captured.count += 1;
      captured.authorizations.push(request.headers.get("authorization") ?? "");
      captured.contentTypes.push(request.headers.get("content-type") ?? "");
      captured.bodies.push(await request.json());
      if (handler) {
        return handler();
      }
      return HttpResponse.json({ ok: true });
    }),
  );
  return captured;
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function guestEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dataOverrides =
    overrides.data && typeof overrides.data === "object" && !Array.isArray(overrides.data)
      ? (overrides.data as Record<string, unknown>)
      : {};
  const { data: _data, ...rest } = overrides;
  return {
    id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
    action: "message.created",
    created: "2024-10-08T07:03:34Z",
    version: "v2",
    ...rest,
    data: {
      id: "msg-100",
      platform: "airbnb",
      conversation_id: "conv-1",
      reservation_id: "res-1",
      content_type: "text/plain",
      body: BODY_CANARY,
      sender_type: "guest",
      sender_role: "guest",
      source: "platform",
      created_at: "2024-10-08T07:03:34Z",
      property: {
        id: "prop-1",
        name: "Sea Villa",
        public_name: "Public Villa",
      },
      listing: { platform: "airbnb", platform_id: "24488" },
      sender: {
        first_name: "Jane",
        full_name: NAME_CANARY,
        locale: "en",
        location: "Austin, TX",
      },
      user: {
        id: "user-1",
        email: EMAIL_CANARY,
        name: NAME_CANARY,
      },
      phone: PHONE_CANARY,
      guest: {
        email: EMAIL_CANARY,
        phone: PHONE_CANARY,
        name: NAME_CANARY,
      },
      ...dataOverrides,
    },
  };
}

function withSecret(secret: string | undefined): Env {
  return withQueue({
    DEDUPE: env.DEDUPE,
    RELAY_PATH_TOKEN: env.RELAY_PATH_TOKEN,
    RESPONDER_WEBHOOK_URL: env.RESPONDER_WEBHOOK_URL,
    RESPONDER_AUTH_HEADER: env.RESPONDER_AUTH_HEADER,
    ENFORCE_HOSPITABLE_IP: env.ENFORCE_HOSPITABLE_IP,
    HOSPITABLE_WEBHOOK_SECRET: secret,
  });
}

async function postRaw(
  raw: string,
  options: {
    signature?: string | null;
    ip?: string | null;
    method?: string;
    env?: Env;
    url?: string;
  } = {},
): Promise<{ response: Response; ctx: ExecutionContext }> {
  const method = options.method ?? "POST";
  const headers = new Headers({ "content-type": "application/json" });
  if (options.signature) {
    headers.set("Signature", options.signature);
  }
  if (options.ip !== null) {
    headers.set("CF-Connecting-IP", options.ip ?? HOSPITABLE_IP);
  }
  const request = new Request(options.url ?? HOOK_URL, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : raw,
  }) as Request<unknown, IncomingRequestCfProperties>;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, options.env ?? withSecret(undefined), ctx);
  return { response, ctx };
}

async function postEvent(
  event: Record<string, unknown>,
  options: {
    signature?: string | null;
    ip?: string | null;
    method?: string;
    env?: Env;
  } = {},
): Promise<{ response: Response; ctx: ExecutionContext; raw: string }> {
  const raw = JSON.stringify(event);
  const result = await postRaw(raw, options);
  return { ...result, raw };
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

function outcomes(lines: string[]): string[] {
  return jsonLogs(lines).map((entry) => entry.outcome as string);
}

function jsonLogs(lines: string[]): Record<string, unknown>[] {
  return lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectNoSensitiveLogs(lines: string[], secrets: string[]): void {
  const logged = lines.join("\n");
  expect(logged).not.toContain("FULL_PAYLOAD_TEMP");
  for (const secret of secrets) {
    expect(logged).not.toContain(secret);
  }
}

describe("hospitable webhook relay", () => {
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    await clearDedupe();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it("forwards a guest message, including text and first name, without other contact fields", async () => {
    const captured = captureRoutine();
    const event = guestEvent();
    const started = Date.now();
    const { response, ctx } = await postEvent(event);
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(elapsed).toBeLessThan(250);

    await settle(ctx);

    expect(captured.count).toBe(1);
    expect(captured.authorizations).toEqual([AUTH]);
    expect(captured.contentTypes).toEqual(["application/json"]);
    expect(captured.bodies).toEqual([
      {
        event_type: "message.created",
        event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
        message_id: "msg-100",
        reservation_id: "res-1",
        conversation_id: "conv-1",
        property_id: "prop-1",
        property_name: "Sea Villa",
        platform: "airbnb",
        sender_type: "guest",
        created_at: "2024-10-08T07:03:34Z",
        body: BODY_CANARY,
        content_type: "text/plain",
        guest_first_name: "Jane",
        guest_location: "Austin, TX",
        source: "hospitable",
        inbox: "hospitable",
        sender: { first_name: "Jane" },
        property: "Sea Villa",
      },
    ]);
    const forwarded = JSON.stringify(captured.bodies[0]);
    expect(forwarded).not.toContain(EMAIL_CANARY);
    expect(forwarded).not.toContain(PHONE_CANARY);
    expect(forwarded).not.toContain(NAME_CANARY);
    expect(Object.keys(captured.bodies[0] as object).sort()).toEqual([...ALLOWED_KEYS].sort());
    expect(await env.DEDUPE.get("message:msg-100")).toBe("1");
    expect(outcomes(logs.lines)).toContain("forwarded");
    const forwardedLog = logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forwardedLog).toContainEqual({
      event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
      message_id: "msg-100",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      relay: "guest-messaging-relay",
      source: "hospitable",
      signature_present: false,
    });
    const logged = JSON.stringify(logs.lines);
    expect(logged).not.toContain(BODY_CANARY);
    expect(logged).not.toContain(NAME_CANARY);
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(AUTH);
  });

  it("omits blank text and missing guest name fields", async () => {
    const captured = captureRoutine();
    const { ctx } = await postEvent(
      guestEvent({
        data: {
          id: "msg-blank",
          body: "   ",
          content_type: "",
          sender: { full_name: NAME_CANARY },
        },
      }),
    );
    await settle(ctx);
    const forwarded = captured.bodies[0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("body");
    expect(forwarded).not.toHaveProperty("content_type");
    expect(forwarded).not.toHaveProperty("guest_first_name");
    expect(forwarded).not.toHaveProperty("guest_location");
    expect(JSON.stringify(forwarded)).not.toContain(NAME_CANARY);
    expect(JSON.stringify(logs.lines)).not.toContain(NAME_CANARY);
    expect(JSON.stringify(logs.lines)).not.toContain(BODY_CANARY);
  });

  it("returns 500 without throwing when required secrets are unset", async () => {
    const captured = captureRoutine();
    const missing: Array<Partial<Env>> = [
      {},
      {
        RESPONDER_WEBHOOK_URL: ROUTINE_URL,
        RESPONDER_AUTH_HEADER: AUTH,
      },
      {
        RELAY_PATH_TOKEN: PATH_TOKEN,
        RESPONDER_AUTH_HEADER: AUTH,
      },
      {
        RELAY_PATH_TOKEN: PATH_TOKEN,
        RESPONDER_WEBHOOK_URL: ROUTINE_URL,
      },
      // A short or placeholder relay password is refused.
      {
        RELAY_PATH_TOKEN: "replace-with-a-long-random-token",
        RESPONDER_WEBHOOK_URL: ROUTINE_URL,
        RESPONDER_AUTH_HEADER: AUTH,
      },
      {
        RELAY_PATH_TOKEN: "abc123",
        RESPONDER_WEBHOOK_URL: ROUTINE_URL,
        RESPONDER_AUTH_HEADER: AUTH,
      },
      // The responder URL must be https.
      {
        RELAY_PATH_TOKEN: PATH_TOKEN,
        RESPONDER_WEBHOOK_URL: "http://routine.example/hooks/guest",
        RESPONDER_AUTH_HEADER: AUTH,
      },
    ];
    for (const partial of missing) {
      const bare = {
        DEDUPE: env.DEDUPE,
        ENFORCE_HOSPITABLE_IP: env.ENFORCE_HOSPITABLE_IP,
        ...partial,
      } as Env;
      const { response, ctx } = await postEvent(guestEvent(), { env: bare });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "misconfigured" });
      await settle(ctx);
    }
    expect(captured.count).toBe(0);
    expect(outcomes(logs.lines)).toEqual(Array(missing.length).fill("misconfigured"));
  });

  it("returns 404 for any path other than /hook/<token>", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(guestEvent());
    for (const url of [
      "https://relay.example/",
      "https://relay.example/hook",
      "https://relay.example/hook/",
      "https://relay.example/hook/wrong-token",
      `https://relay.example/hook/${PATH_TOKEN}/extra`,
      "https://relay.example/hospitable",
    ]) {
      const { response, ctx } = await postRaw(raw, { url });
      expect(response.status, url).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      await settle(ctx);
    }
    expect(captured.count).toBe(0);
    expect(outcomes(logs.lines)).toEqual([
      "rejected_path",
      "rejected_path",
      "rejected_path",
      "rejected_path",
      "rejected_path",
      "rejected_path",
    ]);
    expect(JSON.stringify(logs.lines)).not.toContain(PATH_TOKEN);
    expect(JSON.stringify(logs.lines)).not.toContain("wrong-token");
  });

  it("returns 200 after queueing, without calling the routine", async () => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent(guestEvent({ data: { id: "msg-queued" } }));
    expect(response.status).toBe(200);
    expect(captured.count).toBe(0);
    expect(queuedJobs()).toHaveLength(1);
    expect(queuedJobs()[0]).toMatchObject({ key: "message:msg-queued", message_id: "msg-queued" });
    expect(await env.DEDUPE.get("message:msg-queued")).toBeNull();
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(await env.DEDUPE.get("message:msg-queued")).toBe("1");
  });

  it("returns 500 when the queue rejects the job, so Hospitable retries", async () => {
    const captured = captureRoutine();
    const broken = withQueue(
      {
        DEDUPE: env.DEDUPE,
        RELAY_PATH_TOKEN: env.RELAY_PATH_TOKEN,
        RESPONDER_WEBHOOK_URL: env.RESPONDER_WEBHOOK_URL,
        RESPONDER_AUTH_HEADER: env.RESPONDER_AUTH_HEADER,
      },
      { failSend: true },
    );
    const { response, ctx } = await postEvent(guestEvent(), { env: broken });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "queue_unavailable" });
    await settle(ctx);
    expect(captured.count).toBe(0);
    expect(outcomes(logs.lines)).toEqual(["queue_failed"]);
    expect(JSON.stringify(logs.lines)).not.toContain(BODY_CANARY);
  });

  it("records signature presence and still forwards when no signing secret is set", async () => {
    const captured = captureRoutine();
    const raw = JSON.stringify(guestEvent({ data: { id: "msg-signed-header" } }));
    const headerValue = "signature-value-do-not-log";
    const { response, ctx } = await postRaw(raw, { signature: headerValue });
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
    const forwarded = logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forwarded).toContainEqual({
      event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
      message_id: "msg-signed-header",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      relay: "guest-messaging-relay",
      source: "hospitable",
      signature_present: true,
    });
    expect(JSON.stringify(logs.lines)).not.toContain(headerValue);
  });

  it("requires a valid Signature when HOSPITABLE_WEBHOOK_SECRET is set", async () => {
    const captured = captureRoutine();
    const signedEnv = withSecret(SECRET);
    const raw = JSON.stringify(guestEvent());

    const missing = await postRaw(raw, { env: signedEnv });
    expect(missing.response.status).toBe(401);
    expect(await missing.response.json()).toEqual({ error: "unauthorized" });
    await settle(missing.ctx);

    const bad = await postRaw(raw, { env: signedEnv, signature: "deadbeef" });
    expect(bad.response.status).toBe(401);
    await settle(bad.ctx);

    const good = await postRaw(raw, {
      env: signedEnv,
      signature: (await sign(raw)).toUpperCase(),
    });
    expect(good.response.status).toBe(200);
    await settle(good.ctx);

    expect(captured.count).toBe(1);
    expect(outcomes(logs.lines)).toEqual([
      "rejected_signature",
      "rejected_signature",
      "forwarded",
    ]);
    const forwarded = logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forwarded.find((entry) => entry.outcome === "forwarded")).not.toHaveProperty(
      "signature_present",
    );
    expect(JSON.stringify(logs.lines)).not.toContain("deadbeef");
    expect(JSON.stringify(logs.lines)).not.toContain(SECRET);
  });

  it("answers 405 for non-POST requests", async () => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent(guestEvent(), { method: "GET" });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
    await settle(ctx);
    expect(captured.count).toBe(0);
    expect(outcomes(logs.lines)).toEqual(["rejected_method"]);
  });

  it("rejects source IPs outside 38.80.170.0/24 and allows the full /24", async () => {
    const captured = captureRoutine();
    const outside = await postEvent(guestEvent(), { ip: "38.80.171.10" });
    expect(outside.response.status).toBe(401);
    await settle(outside.ctx);

    const missing = await postEvent(guestEvent(), { ip: null });
    expect(missing.response.status).toBe(401);
    await settle(missing.ctx);

    const edge = await postEvent(guestEvent({ id: "evt-edge", data: { id: "msg-edge" } }), {
      ip: "38.80.170.255",
    });
    expect(edge.response.status).toBe(200);
    await settle(edge.ctx);

    const documentedEdge = await postEvent(
      guestEvent({ id: "evt-24", data: { id: "msg-24" } }),
      { ip: "38.80.170.24" },
    );
    expect(documentedEdge.response.status).toBe(200);
    await settle(documentedEdge.ctx);

    expect(captured.count).toBe(2);
    expect(outcomes(logs.lines)).toContain("rejected_ip");
  });

  it("skips the IP check when ENFORCE_HOSPITABLE_IP is false", async () => {
    const captured = captureRoutine();
    const relaxed = withQueue({
      DEDUPE: env.DEDUPE,
      RELAY_PATH_TOKEN: env.RELAY_PATH_TOKEN,
      RESPONDER_WEBHOOK_URL: env.RESPONDER_WEBHOOK_URL,
      RESPONDER_AUTH_HEADER: env.RESPONDER_AUTH_HEADER,
      ENFORCE_HOSPITABLE_IP: "false",
    });
    const { response, ctx } = await postEvent(guestEvent(), {
      ip: "203.0.113.5",
      env: relaxed,
    });
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
  });

  it.each([
    ["owner", "owner"],
    ["null", null],
  ])("forwards a guest message when sender_role is %s", async (label, senderRole) => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent(
      guestEvent({ data: { id: `msg-role-${label}`, sender_role: senderRole } }),
    );
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(outcomes(logs.lines)).toContain("forwarded");
  });

  it.each([
    ["host", { sender_type: "host", sender_role: "host" }, { sender_type: "host", sender_role: "host", msg_source: "platform" }],
    ["system", { sender_type: "system", sender_role: "system" }, { sender_type: "system", sender_role: "system", msg_source: "platform" }],
    ["automated", { source: "automated" }, { sender_type: "guest", sender_role: "guest", msg_source: "automated" }],
    ["AI", { source: "AI" }, { sender_type: "guest", sender_role: "guest", msg_source: "AI" }],
    ["team", { sender_type: "team", sender_role: "team" }, { sender_type: "team", sender_role: "team", msg_source: "platform" }],
    ["missing sender_type", { sender_type: undefined }, { sender_role: "guest", msg_source: "platform" }],
    ["unknown sender_type", { sender_type: "cohost" }, { sender_type: "cohost", sender_role: "guest", msg_source: "platform" }],
    ["public_api", { source: "public_api" }, { sender_type: "guest", sender_role: "guest", msg_source: "public_api" }],
  ])("drops a %s message and does not forward it", async (_label, dataOverrides, logged) => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent(guestEvent({ data: dataOverrides }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await settle(ctx);
    expect(captured.count).toBe(0);
    expect(logs.lines.map((line) => JSON.parse(line))).toContainEqual({
      event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
      message_id: "msg-100",
      outcome: "dropped_non_guest",
      routine_status: null,
      relay: "guest-messaging-relay",
      source: "hospitable",
      signature_present: false,
      ...logged,
    });
    const serialized = JSON.stringify(logs.lines);
    expect(serialized).not.toContain(BODY_CANARY);
    expect(serialized).not.toContain(NAME_CANARY);
    expect(serialized).not.toContain(EMAIL_CANARY);
    expect(await env.DEDUPE.get("message:msg-100")).toBeNull();
  });

  it("drops a property event and other unhandled actions with 200", async () => {
    const captured = captureRoutine();
    const property = await postEvent({
      id: "evt-prop",
      action: "property.created",
      data: {
        id: "prop-9",
        name: "Sea Villa",
        body: BODY_CANARY,
        guest: { email: EMAIL_CANARY, phone: PHONE_CANARY, name: NAME_CANARY },
      },
    });
    expect(property.response.status).toBe(200);
    expect(await property.response.json()).toEqual({ ok: true });
    await settle(property.ctx);

    const updated = await postEvent(
      guestEvent({ id: "evt-upd", action: "message.updated", data: { id: "msg-upd" } }),
    );
    expect(updated.response.status).toBe(200);
    await settle(updated.ctx);

    expect(captured.count).toBe(0);
    expect(jsonLogs(logs.lines)).toEqual([
      {
        event_id: "evt-prop",
        message_id: "prop-9",
        outcome: "dropped_action",
        routine_status: null,
        relay: "guest-messaging-relay",
        source: "hospitable",
        action: "property.created",
        signature_present: false,
      },
      {
        event_id: "evt-upd",
        message_id: "msg-upd",
        outcome: "dropped_action",
        routine_status: null,
        relay: "guest-messaging-relay",
        source: "hospitable",
        action: "message.updated",
        signature_present: false,
      },
    ]);
    const logged = JSON.stringify(logs.lines);
    expect(logged).not.toContain("FULL_PAYLOAD_TEMP");
    expect(logged).not.toContain(BODY_CANARY);
    expect(logged).not.toContain(NAME_CANARY);
    expect(logged).not.toContain(EMAIL_CANARY);
    expect(await env.DEDUPE.get("event:evt-prop")).toBeNull();
  });

  it("forwards a duplicate message id only once", async () => {
    const captured = captureRoutine();
    const first = await postEvent(guestEvent());
    await settle(first.ctx);
    const second = await postEvent(
      guestEvent({ id: "01GTKD6ZYFVQMR0RWP4HBBHNZD" }),
    );
    expect(second.response.status).toBe(200);
    await settle(second.ctx);
    expect(captured.count).toBe(1);
    expect(outcomes(logs.lines)).toEqual(["forwarded", "duplicate"]);
  });

  it("forwards a numeric data.id as message_id and dedupes on that string", async () => {
    const captured = captureRoutine();
    const first = await postEvent(
      guestEvent({ id: "evt-numeric-a", data: { id: 1317148950 } }),
    );
    await settle(first.ctx);
    const second = await postEvent(
      guestEvent({ id: "evt-numeric-b", data: { id: 1317148950 } }),
    );
    expect(second.response.status).toBe(200);
    await settle(second.ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toMatchObject({ message_id: "1317148950" });
    expect(await env.DEDUPE.get("message:1317148950")).toBe("1");
    expect(await env.DEDUPE.get("event:evt-numeric-a")).toBeNull();
  });

  it("forwards a real v2 guest payload with a numeric id and no sender_role", async () => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent({
      id: "01JREALGUESTWEBHOOK00000000",
      action: "message.created",
      created: "2024-10-08T07:03:34Z",
      version: "v2",
      data: {
        id: 1317148950,
        source: "platform",
        sender_type: "guest",
        body: BODY_CANARY,
        created_at: "2024-10-08T07:03:34Z",
        property: {
          id: "prop-real",
          name: "Sea Villa",
          public_name: "Public Villa",
        },
        listing: { platform: "airbnb", platform_id: "24488" },
        sender: { full_name: NAME_CANARY },
      },
    });
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toEqual({
      event_type: "message.created",
      event_id: "01JREALGUESTWEBHOOK00000000",
      message_id: "1317148950",
      property_id: "prop-real",
      property_name: "Sea Villa",
      platform: "airbnb",
      sender_type: "guest",
      created_at: "2024-10-08T07:03:34Z",
      body: BODY_CANARY,
      source: "hospitable",
      inbox: "hospitable",
      sender: {},
      property: "Sea Villa",
    });
    const forwarded = JSON.stringify(captured.bodies[0]);
    expect(forwarded).not.toContain(NAME_CANARY);
    expect(JSON.stringify(logs.lines)).not.toContain(BODY_CANARY);
    expect(JSON.stringify(logs.lines)).not.toContain(NAME_CANARY);
    expect(await env.DEDUPE.get("message:1317148950")).toBe("1");
  });

  it("drops a host public_api message", async () => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent({
      id: "01JREALHOSTWEBHOOK000000000",
      action: "message.created",
      created: "2024-10-08T07:03:34Z",
      version: "v2",
      data: {
        id: 1317148951,
        source: "public_api",
        sender_type: "host",
        sender_role: "host",
        body: BODY_CANARY,
        property: {
          id: "prop-real",
          name: "Sea Villa",
          public_name: "Public Villa",
        },
        listing: { platform: "airbnb", platform_id: "24488" },
        sender: { full_name: NAME_CANARY },
      },
    });
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(captured.count).toBe(0);
    expect(logs.lines.map((line) => JSON.parse(line))).toContainEqual({
      event_id: "01JREALHOSTWEBHOOK000000000",
      message_id: "1317148951",
      outcome: "dropped_non_guest",
      routine_status: null,
      relay: "guest-messaging-relay",
      source: "hospitable",
      signature_present: false,
      sender_type: "host",
      sender_role: "host",
      msg_source: "public_api",
    });
    const serialized = JSON.stringify(logs.lines);
    expect(serialized).not.toContain(BODY_CANARY);
    expect(serialized).not.toContain(NAME_CANARY);
    expect(await env.DEDUPE.get("message:1317148951")).toBeNull();
  });

  it("dedupes on the webhook event id when the message id is absent", async () => {
    const captured = captureRoutine();
    const event = guestEvent({ data: { id: undefined } });
    const first = await postEvent(event);
    await settle(first.ctx);
    const second = await postEvent(event);
    await settle(second.ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toMatchObject({
      event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
      sender_type: "guest",
    });
    expect(captured.bodies[0]).not.toHaveProperty("message_id");
    expect(await env.DEDUPE.get("event:01GTKD6ZYFVQMR0RWP4HBBHNZC")).toBe("1");
  });

  it("uses property.public_name when property.name is absent", async () => {
    const captured = captureRoutine();
    const { ctx } = await postEvent(
      guestEvent({
        data: {
          id: "msg-public-name",
          property: { id: "prop-2", public_name: "Public Villa" },
          platform: undefined,
          listing: { platform: "vrbo", platform_id: "9" },
        },
      }),
    );
    await settle(ctx);
    expect(captured.bodies[0]).toMatchObject({
      property_id: "prop-2",
      property_name: "Public Villa",
      platform: "vrbo",
    });
  });

  it("retries a failed delivery from the queue until the routine accepts it", async () => {
    let calls = 0;
    const captured = captureRoutine(() => {
      calls += 1;
      if (calls <= 2) {
        return new HttpResponse(null, { status: 500 });
      }
      return HttpResponse.json({ ok: true });
    });

    const first = await postEvent(guestEvent());
    expect(first.response.status).toBe(200);
    await settle(first.ctx);
    expect(captured.count).toBe(1);
    expect(await env.DEDUPE.get("message:msg-100")).toBeNull();
    expect(logs.lines.map((line) => JSON.parse(line))).toContainEqual({
      event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
      message_id: "msg-100",
      outcome: "forward_failed",
      routine_status: 500,
      attempt: 1,
      relay: "guest-messaging-relay",
      source: "hospitable",
      signature_present: false,
    });

    const second = await drainQueue();
    expect(second.retried).toBe(1);
    expect(captured.count).toBe(2);
    expect(await env.DEDUPE.get("message:msg-100")).toBeNull();

    const third = await drainQueue();
    expect(third.acked).toBe(1);
    expect(captured.count).toBe(3);
    expect(await env.DEDUPE.get("message:msg-100")).toBe("1");
    expect(queuedJobs()).toHaveLength(0);
    expect(jsonLogs(logs.lines).filter((entry) => entry.outcome === "forwarded")).toEqual([
      expect.objectContaining({ message_id: "msg-100", routine_status: 200, attempt: 3 }),
    ]);
  });

  it("logs routine_status 0 when the routine request throws, and retries", async () => {
    network.use(
      http.post(ROUTINE_URL, () => {
        return HttpResponse.error();
      }),
    );
    const { response, ctx } = await postEvent(guestEvent());
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(await env.DEDUPE.get("message:msg-100")).toBeNull();
    const failed = logs.lines
      .map((line) => JSON.parse(line) as { outcome: string; routine_status: number | null })
      .find((entry) => entry.outcome === "forward_failed");
    expect(failed?.routine_status).toBe(0);
    expect(queuedJobs()).toHaveLength(1);
  });

  it("skips a queued job whose message was already forwarded", async () => {
    const captured = captureRoutine();
    const first = await postEvent(guestEvent());
    const second = await postEvent(guestEvent({ id: "evt-again" }));
    expect(queuedJobs()).toHaveLength(2);
    await settle(first.ctx);
    await settle(second.ctx);
    expect(captured.count).toBe(1);
    expect(outcomes(logs.lines)).toEqual(expect.arrayContaining(["forwarded", "duplicate"]));
  });

  it("delivers a job too large for the queue directly instead", async () => {
    const captured = captureRoutine();
    const { response, ctx } = await postEvent({
      id: "evt-huge",
      action: "reservation.created",
      data: { id: "res-huge", notes: "N".repeat(130_000) },
    });
    expect(response.status).toBe(200);
    expect(queuedJobs()).toHaveLength(0);
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(outcomes(logs.lines)).toEqual(["queue_bypassed_size", "forwarded"]);
    expect(await env.DEDUPE.get("event:evt-huge")).toBe("1");
  });

  it("backs off from one minute to one hour, within 24 hours over all retries", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(7)).toBe(3600);
    expect(retryDelaySeconds(50)).toBe(3600);
    let total = 0;
    for (let attempt = 1; attempt <= MAX_DELIVERY_RETRIES; attempt++) {
      total += retryDelaySeconds(attempt);
    }
    expect(total).toBeLessThan(24 * 60 * 60);
  });

  it("keeps the dedupe TTL at 24 hours", () => {
    expect(DEDUPE_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("forwards review.created from the reservation, property, and guest objects", async () => {
    const captured = captureRoutine();
    const data = {
      id: "rev-77",
      platform: "airbnb",
      public: { rating: 4, response: "Glad you enjoyed it" },
      can_respond: true,
      reservation_id: "flat-should-ignore",
      reservation: {
        id: "res-nested",
        code: "HMABCD",
        check_in: "2024-12-01",
        check_out: "2024-12-05",
      },
      property_id: "flat-prop",
      property_name: "flat-name",
      property: { id: "prop-7", name: "Cliff House", public_name: "Public Cliff" },
      guest: {
        first_name: "Jane",
        full_name: NAME_CANARY,
        email: EMAIL_CANARY,
        phone: PHONE_CANARY,
      },
      listing: { platform: "vrbo" },
    };
    const { response, ctx } = await postEvent({
      id: "evt-review",
      action: "review.created",
      created: "2024-11-01T15:04:05Z",
      version: "v2",
      data,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await settle(ctx);

    expect(captured.count).toBe(1);
    expect(captured.authorizations).toEqual([AUTH]);
    expect(captured.bodies[0]).toEqual({
      event_type: "review.created",
      event_id: "evt-review",
      created: "2024-11-01T15:04:05Z",
      review_id: "rev-77",
      platform: "airbnb",
      rating: 4,
      can_respond: true,
      has_response: true,
      reservation_id: "res-nested",
      reservation_code: "HMABCD",
      check_in: "2024-12-01",
      check_out: "2024-12-05",
      property_id: "prop-7",
      property_name: "Cliff House",
      guest_first_name: "Jane",
      review: data,
    });
    expect(await env.DEDUPE.get("event:evt-review")).toBe("1");
    expect(await env.DEDUPE.get("message:rev-77")).toBeNull();
    expect(jsonLogs(logs.lines)).toContainEqual({
      event_id: "evt-review",
      message_id: "rev-77",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      relay: "guest-messaging-relay",
      source: "hospitable",
      action: "review.created",
      signature_present: false,
    });
    expectNoSensitiveLogs(logs.lines, [
      NAME_CANARY,
      EMAIL_CANARY,
      PHONE_CANARY,
      "Jane",
      "Glad you enjoyed it",
      STREET_CANARY,
      COORD_CANARY,
    ]);
  });

  it("forwards reservation.created, trims properties, and dedupes on the event id", async () => {
    const captured = captureRoutine();
    const kept = {
      id: "prop-9",
      name: "Cabin",
      public_name: "Public Cabin",
      timezone: "America/Chicago",
      checkin: "16:00",
      checkout: "10:00",
      capacity: { max: 6 },
      house_rules: "No parties",
    };
    const data = {
      id: "res-100",
      code: "ABC123",
      platform: "airbnb",
      status: "accepted",
      properties: [
        {
          ...kept,
          address: {
            street: STREET_CANARY,
            city: "Austin",
            state: "TX",
            coordinates: { latitude: COORD_CANARY, longitude: "-97.7431" },
          },
          coordinates: { lat: COORD_CANARY, lng: "-97.7431" },
          description: DESCRIPTION_CANARY,
          summary: SUMMARY_CANARY,
          amenities: ["heated pool"],
          room_details: [{ type: "bedroom" }],
          picture: PICTURE_CANARY,
        },
        {
          id: "prop-10",
          public_name: "Annex",
          address: { street: STREET_CANARY, city: "Dallas", state: "TX" },
          description: DESCRIPTION_CANARY,
        },
      ],
      property: {
        id: "decoy-prop",
        name: "Wrong",
        address: { street: STREET_CANARY, city: "Nope", state: "ZZ" },
        coordinates: { lat: COORD_CANARY, lng: "-97.7431" },
        picture: PICTURE_CANARY,
      },
      property_id: "flat-should-ignore",
      check_in: "2024-12-01",
      check_out: "2024-12-05",
      arrival_date: "1999-01-01",
      nights: 4,
      guests: { total: 3, adult_count: 2 },
      guest: {
        first_name: "Jane",
        full_name: NAME_CANARY,
        email: EMAIL_CANARY,
        phone: PHONE_CANARY,
      },
      listing: { platform: "vrbo" },
    };
    const { response, ctx } = await postEvent({
      id: "evt-res",
      action: "reservation.created",
      created: "2024-11-02T08:00:00Z",
      triggers: "not-an-array",
      data,
    });
    expect(response.status).toBe(200);
    await settle(ctx);

    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toEqual({
      event_type: "reservation.created",
      event_id: "evt-res",
      created: "2024-11-02T08:00:00Z",
      reservation_id: "res-100",
      code: "ABC123",
      platform: "airbnb",
      status: "accepted",
      property_id: "prop-9",
      property_name: "Cabin",
      property_city: "Austin",
      property_state: "TX",
      check_in: "2024-12-01",
      check_out: "2024-12-05",
      nights: 4,
      guest_count: 3,
      guest_first_name: "Jane",
      reservation: {
        ...data,
        properties: [kept, { id: "prop-10", public_name: "Annex" }],
        property: { id: "decoy-prop", name: "Wrong" },
      },
    });
    const forwarded = JSON.stringify(captured.bodies[0]);
    expect(forwarded).not.toContain(STREET_CANARY);
    expect(forwarded).not.toContain(COORD_CANARY);
    expect(forwarded).not.toContain(DESCRIPTION_CANARY);
    expect(forwarded).not.toContain(SUMMARY_CANARY);
    expect(forwarded).not.toContain(PICTURE_CANARY);
    expect(forwarded).not.toContain("heated pool");
    expect(forwarded).not.toContain("room_details");
    expect(forwarded).not.toContain("Dallas");
    expect(forwarded).not.toContain("Nope");
    expect(await env.DEDUPE.get("event:evt-res")).toBe("1");
    expect(await env.DEDUPE.get("message:res-100")).toBeNull();
    expect(jsonLogs(logs.lines)).toContainEqual({
      event_id: "evt-res",
      message_id: "res-100",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      relay: "guest-messaging-relay",
      source: "hospitable",
      action: "reservation.created",
      signature_present: false,
    });
    expectNoSensitiveLogs(logs.lines, [
      NAME_CANARY,
      EMAIL_CANARY,
      PHONE_CANARY,
      "Jane",
      STREET_CANARY,
      COORD_CANARY,
      DESCRIPTION_CANARY,
      PICTURE_CANARY,
    ]);
  });

  it("forwards reservation.changed with status category, guest count, and triggers", async () => {
    const captured = captureRoutine();
    const kept = {
      id: "prop-3",
      name: "Lake House",
      public_name: "Public Lake",
      timezone: "America/Chicago",
      checkin: "15:00",
      checkout: "11:00",
      capacity: 4,
      house_rules: "Quiet hours",
    };
    const data = {
      id: 42,
      code: "XYZ",
      platform: "vrbo",
      reservation_status: { current: { category: "cancelled" } },
      properties: [
        {
          ...kept,
          address: {
            street: STREET_CANARY,
            city: "Austin",
            state: "TX",
            coordinates: { latitude: COORD_CANARY, longitude: "-97.7431" },
          },
          coordinates: { lat: COORD_CANARY, lng: "-97.7431" },
          description: DESCRIPTION_CANARY,
          summary: SUMMARY_CANARY,
          amenities: ["dock"],
          room_details: [{ type: "loft" }],
          picture: PICTURE_CANARY,
        },
      ],
      property: {
        id: "ignored-prop",
        public_name: "Not This",
        address: { street: STREET_CANARY, city: "Nope", state: "ZZ" },
      },
      check_in: "2025-01-01",
      check_out: "2025-01-04",
      arrival_date: "1999-01-01",
      departure_date: "1999-01-04",
      nights: 3,
      guests: { total: 2 },
      guest: { first_name: "Sam", full_name: NAME_CANARY, email: EMAIL_CANARY, phone: PHONE_CANARY },
      listing: { platform: "airbnb" },
    };
    const triggers = ["checkin", "status"];
    const { response, ctx } = await postEvent({
      id: "evt-res-chg",
      action: "reservation.changed",
      created: "2024-11-02T09:00:00Z",
      triggers,
      data,
    });
    expect(response.status).toBe(200);
    await settle(ctx);

    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toEqual({
      event_type: "reservation.changed",
      event_id: "evt-res-chg",
      created: "2024-11-02T09:00:00Z",
      reservation_id: "42",
      code: "XYZ",
      platform: "vrbo",
      status: "cancelled",
      property_id: "prop-3",
      property_name: "Lake House",
      property_city: "Austin",
      property_state: "TX",
      check_in: "2025-01-01",
      check_out: "2025-01-04",
      nights: 3,
      guest_count: 2,
      guest_first_name: "Sam",
      triggers,
      reservation: {
        ...data,
        properties: [kept],
        property: { id: "ignored-prop", public_name: "Not This" },
      },
    });
    const forwarded = JSON.stringify(captured.bodies[0]);
    expect(forwarded).not.toContain(STREET_CANARY);
    expect(forwarded).not.toContain(COORD_CANARY);
    expect(forwarded).not.toContain(DESCRIPTION_CANARY);
    expect(forwarded).not.toContain(SUMMARY_CANARY);
    expect(forwarded).not.toContain(PICTURE_CANARY);
    expect(forwarded).not.toContain("room_details");
    expect(forwarded).not.toContain("Nope");
    expect(await env.DEDUPE.get("event:evt-res-chg")).toBe("1");
    expect(jsonLogs(logs.lines)).toContainEqual({
      event_id: "evt-res-chg",
      message_id: "42",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      relay: "guest-messaging-relay",
      source: "hospitable",
      action: "reservation.changed",
      signature_present: false,
    });
    expectNoSensitiveLogs(logs.lines, [
      NAME_CANARY,
      EMAIL_CANARY,
      PHONE_CANARY,
      "Sam",
      STREET_CANARY,
      COORD_CANARY,
      DESCRIPTION_CANARY,
      PICTURE_CANARY,
    ]);
  });

  it("forwards a duplicate review only once", async () => {
    const captured = captureRoutine();
    const event = {
      id: "evt-review-dup",
      action: "review.created",
      created: "2024-11-01T15:04:05Z",
      data: {
        id: "rev-dup",
        public: { rating: 5 },
        property: { id: "prop-1", name: "Sea Villa" },
      },
    };
    const first = await postEvent(event);
    await settle(first.ctx);
    const second = await postEvent(event);
    expect(second.response.status).toBe(200);
    expect(await second.response.json()).toEqual({ ok: true });
    await settle(second.ctx);

    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toMatchObject({
      event_type: "review.created",
      event_id: "evt-review-dup",
      review_id: "rev-dup",
      rating: 5,
      has_response: false,
    });
    expect(await env.DEDUPE.get("event:evt-review-dup")).toBe("1");
    expect(jsonLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["forwarded", "duplicate"]);
    expect(jsonLogs(logs.lines)).toContainEqual({
      event_id: "evt-review-dup",
      message_id: "rev-dup",
      outcome: "duplicate",
      routine_status: null,
      relay: "guest-messaging-relay",
      source: "hospitable",
      action: "review.created",
      signature_present: false,
    });
    expectNoSensitiveLogs(logs.lines, ["FULL_PAYLOAD_TEMP"]);
  });

  it("drops a review or reservation that has no event id or no data", async () => {
    const captured = captureRoutine();
    const noId = await postEvent({
      action: "review.created",
      created: "2024-11-01T15:04:05Z",
      data: { id: "rev-missing-event", body: BODY_CANARY },
    });
    expect(noId.response.status).toBe(200);
    await settle(noId.ctx);

    const noData = await postEvent({
      id: "evt-res-nodata",
      action: "reservation.changed",
      created: "2024-11-01T15:04:05Z",
      data: null,
    });
    expect(noData.response.status).toBe(200);
    await settle(noData.ctx);

    expect(captured.count).toBe(0);
    expect(jsonLogs(logs.lines)).toEqual([
      {
        event_id: null,
        message_id: "rev-missing-event",
        outcome: "dropped_no_id",
        routine_status: null,
        relay: "guest-messaging-relay",
        source: "hospitable",
        action: "review.created",
        signature_present: false,
      },
      {
        event_id: "evt-res-nodata",
        message_id: null,
        outcome: "dropped_no_id",
        routine_status: null,
        relay: "guest-messaging-relay",
        source: "hospitable",
        action: "reservation.changed",
        signature_present: false,
      },
    ]);
    expectNoSensitiveLogs(logs.lines, [BODY_CANARY, "FULL_PAYLOAD_TEMP"]);
  });

  it("never logs a guest message body or guest name", async () => {
    const captured = captureRoutine();
    const { ctx } = await postEvent(
      guestEvent({
        data: {
          id: "msg-private",
          body: BODY_CANARY,
          sender: { first_name: "Jane", full_name: NAME_CANARY, location: "Austin, TX" },
        },
      }),
    );
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(captured.bodies[0]).toMatchObject({
      event_type: "message.created",
      body: BODY_CANARY,
      guest_first_name: "Jane",
    });
    const logged = logs.lines.join("\n");
    expect(logged).not.toContain(BODY_CANARY);
    expect(logged).not.toContain(NAME_CANARY);
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain("FULL_PAYLOAD_TEMP");
    expect(jsonLogs(logs.lines)).toContainEqual({
      event_id: "01GTKD6ZYFVQMR0RWP4HBBHNZC",
      message_id: "msg-private",
      outcome: "forwarded",
      attempt: 1,
      routine_status: 200,
      relay: "guest-messaging-relay",
      source: "hospitable",
      signature_present: false,
    });
  });
});
