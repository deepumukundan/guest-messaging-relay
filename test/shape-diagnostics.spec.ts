import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  emitPayloadShape,
  payloadShape,
  SHAPE_DIAGNOSTICS,
  SHAPE_DIAGNOSTICS_SOURCES,
  SHAPE_MAX_BYTES,
  SHAPE_MAX_DEPTH,
  SHAPE_TRUNCATED,
  type ArrayShape,
  type ObjectShape,
} from "../src/shape-diagnostics";
import { network } from "./network";
import { settle, withQueue } from "./queue";

const PATH_TOKEN = "testpathtoken0123456789abcdefABCDEF";
const ROUTINE_URL = "https://routine.example/hooks/guest";
const QUO_SECRET = btoa("quo-test-signing-secret");
const WA_VERIFY = "wa-verify-token";
const WA_APP = "wa-app-secret";
const RELAY = "guest-messaging-relay";
const BODY_CANARY = "QUO-BODY-CANARY-do-not-log";
const NAME_CANARY = "Nala Private";
const EMAIL_CANARY = "guest@example.com";
const URL_CANARY = "https://cdn.example/media/secret-file";
const ID_CANARY = "wamid.CANARY";
const PHONE_CANARY = "+15555550199";
const DIGITS_CANARY = "15555550198";
const AUTH_CANARY = "Bearer header-canary-do-not-log";
const SIG_CANARY = "hmac;1;1;signature-canary-do-not-log";

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function asObject(shape: unknown): ObjectShape {
  return shape as ObjectShape;
}

function asArray(shape: unknown): ArrayShape {
  return shape as ArrayShape;
}

describe("payload shape redactor", () => {
  it("logs allowlisted tokens and only types for everything else", () => {
    const shape = asObject(
      payloadShape({
        apiVersion: "2026-03-30",
        type: "message.received",
        object: "event",
        event: "message.received",
        messaging_product: "whatsapp",
        field: "messages",
        status: "received",
        direction: "incoming",
        id: ID_CANARY,
        body: BODY_CANARY,
        text: BODY_CANARY,
        name: NAME_CANARY,
        email: EMAIL_CANARY,
        from: PHONE_CANARY,
        wa_id: DIGITS_CANARY,
        link: URL_CANARY,
        media_id: "media-canary",
        createdAt: "2026-04-13T12:00:00.000Z",
        day: "2026-04-13",
        note: "April 13",
        count: 42,
        flag: true,
        empty: null,
        data: {
          resource: {
            direction: "incoming",
            status: "received",
            object: "message",
            text: BODY_CANARY,
          },
        },
      }),
    );

    expect(shape.apiVersion).toBe("2026-03-30");
    expect(shape.type).toBe("message.received");
    expect(shape.object).toBe("event");
    expect(shape.event).toBe("message.received");
    expect(shape.messaging_product).toBe("whatsapp");
    expect(shape.field).toBe("messages");
    expect(shape.status).toBe("received");
    expect(shape.direction).toBe("incoming");
    expect(shape.id).toBe(`string(len=${ID_CANARY.length})`);
    expect(shape.body).toBe(`string(len=${BODY_CANARY.length})`);
    expect(shape.text).toBe(`string(len=${BODY_CANARY.length})`);
    expect(shape.name).toBe(`string(len=${NAME_CANARY.length})`);
    expect(shape.email).toBe(`string(len=${EMAIL_CANARY.length})`);
    expect(shape.from).toBe("e164");
    expect(shape.wa_id).toBe(`string(len=${DIGITS_CANARY.length})`);
    expect(shape.link).toBe(`string(len=${URL_CANARY.length})`);
    expect(shape.media_id).toBe("string(len=12)");
    expect(shape.createdAt).toBe("datetime");
    expect(shape.day).toBe("datetime");
    expect(shape.note).toBe("string(len=8)");
    expect(shape.count).toBe("number");
    expect(shape.flag).toBe("boolean");
    expect(shape.empty).toBe("null");

    const resource = asObject(asObject(shape.data).resource);
    expect(resource.direction).toBe("incoming");
    expect(resource.status).toBe("received");
    expect(resource.object).toBe("message");
    expect(resource.text).toBe(`string(len=${BODY_CANARY.length})`);

    const logged = JSON.stringify(shape);
    for (const secret of [BODY_CANARY, NAME_CANARY, EMAIL_CANARY, URL_CANARY, ID_CANARY, PHONE_CANARY, DIGITS_CANARY, "42"]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain("media-canary");
    expect(logged).not.toContain("2026-04-13T12:00:00.000Z");
  });

  it("refuses allowlisted values that are not short tokens", () => {
    const shape = asObject(
      payloadShape({
        direction: PHONE_CANARY,
        type: `${"x".repeat(41)}`,
        status: "image/jpeg",
        object: "in coming",
        field: "",
        event: 7,
        apiVersion: true,
      }),
    );
    expect(shape.direction).toBe("string");
    expect(shape.type).toBe("string");
    expect(shape.status).toBe("string");
    expect(shape.object).toBe("string");
    expect(shape.field).toBe("string");
    expect(shape.event).toBe("number");
    expect(shape.apiVersion).toBe("boolean");
    const logged = JSON.stringify(shape);
    expect(logged).not.toContain(PHONE_CANARY);
    expect(logged).not.toContain("x".repeat(41));
    expect(logged).not.toContain("image/jpeg");
    expect(logged).not.toContain("string(len=");
  });

  it("describes only the first two array elements and keeps the length", () => {
    const shape = asArray(
      payloadShape([
        { type: "text", body: "first-body" },
        { type: "image", id: ID_CANARY },
        { type: "audio", body: "THIRD-ONLY-CANARY" },
      ]),
    );
    expect(shape.length).toBe(3);
    expect(shape.array).toHaveLength(2);
    expect(asObject(shape.array[0]).type).toBe("text");
    expect(asObject(shape.array[0]).body).toBe("string(len=10)");
    expect(asObject(shape.array[1]).type).toBe("image");
    expect(asObject(shape.array[1]).id).toBe(`string(len=${ID_CANARY.length})`);
    expect(JSON.stringify(shape)).not.toContain("THIRD-ONLY-CANARY");
    expect(JSON.stringify(shape)).not.toContain(ID_CANARY);
  });

  it("stops at the depth cap and marks the parent truncated", () => {
    let value: unknown = { leaf: "DEPTH-CANARY-VALUE" };
    for (let i = 0; i < SHAPE_MAX_DEPTH; i++) {
      value = { nest: value };
    }
    const shape = asObject(payloadShape(value));
    const logged = JSON.stringify(shape);
    expect(logged).not.toContain("DEPTH-CANARY-VALUE");
    expect(logged).not.toContain("leaf");
    expect(shape.nest).toBeTypeOf("object");
    expect(logged).toContain(`"${SHAPE_TRUNCATED}":true`);
  });

  it("keeps the shape within the byte cap and marks it truncated", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 400; index++) {
      wide[`field_${index}_${"k".repeat(30)}`] = {
        body: `${BODY_CANARY}-${"y".repeat(80)}`,
        phone: PHONE_CANARY,
      };
    }
    const shape = payloadShape(wide);
    expect(utf8Bytes(shape)).toBeLessThanOrEqual(SHAPE_MAX_BYTES);
    expect(JSON.stringify(shape)).toContain(`"${SHAPE_TRUNCATED}":true`);
    expect(JSON.stringify(shape)).not.toContain(BODY_CANARY);
    expect(JSON.stringify(shape)).not.toContain(PHONE_CANARY);
  });

  it("does not mark a small payload truncated", () => {
    const shape = payloadShape({ type: "message.received", n: 1 });
    expect(JSON.stringify(shape)).not.toContain(SHAPE_TRUNCATED);
  });

  it("emits unparsed for invalid JSON and never throws", () => {
    expect(SHAPE_DIAGNOSTICS).toBe(true);
    expect([...SHAPE_DIAGNOSTICS_SOURCES]).toEqual(["whatsapp"]);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    try {
      emitPayloadShape(RELAY, "quo", new TextEncoder().encode("not-json"), "invalid_payload", null);
      emitPayloadShape(RELAY, "whatsapp", new Uint8Array([0xff]), "invalid_payload", null);
      log.mockImplementation(() => {
        throw new Error("log failed");
      });
      expect(() => emitPayloadShape(RELAY, "whatsapp", new TextEncoder().encode("{}"), null, null)).not.toThrow();
    } finally {
      log.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ diag: "payload_shape", shape: "unparsed", source: "whatsapp" });
    expect(lines[0]).not.toContain("not-json");
  });
});

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

function jsonLogs(lines: string[]): Record<string, unknown>[] {
  return lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function diagLogs(lines: string[]): Record<string, unknown>[] {
  return jsonLogs(lines).filter((entry) => entry.diag === "payload_shape");
}

function statusLogs(lines: string[]): Record<string, unknown>[] {
  return jsonLogs(lines).filter((entry) => entry.diag !== "payload_shape");
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
  return `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function post(
  url: string,
  raw: string,
  headers: Record<string, string>,
  testEnv: Env = baseEnv(),
): Promise<{ response: Response; ctx: ExecutionContext }> {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH_CANARY, ...headers },
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

describe("payload shape diagnostics on verified routes", () => {
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    await clearDedupe();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it("forwards a legacy Quo message and does not emit a shape line", async () => {
    const captured = { count: 0 };
    network.use(
      http.post(ROUTINE_URL, () => {
        captured.count += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    const raw = JSON.stringify({
      id: "EV-shape",
      object: "event",
      apiVersion: "v2",
      createdAt: "2022-01-23T16:55:52.557Z",
      type: "message.received",
      data: {
        object: {
          id: "AC-shape",
          object: "message",
          from: PHONE_CANARY,
          to: "+15555550100",
          direction: "incoming",
          body: BODY_CANARY,
          status: "received",
          createdAt: "2022-01-23T16:55:52.420Z",
        },
      },
    });
    const signature = await quoHeader(raw);
    const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": signature });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await settle(ctx);
    expect(captured.count).toBe(1);

    expect(diagLogs(logs.lines)).toEqual([]);
    expect(statusLogs(logs.lines).map((entry) => entry.outcome)).toEqual(["forwarded"]);

    const logged = logs.lines.join("\n");
    expect(logged).not.toContain(BODY_CANARY);
    expect(logged).not.toContain(PHONE_CANARY);
    expect(logged).not.toContain("+15555550100");
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain(AUTH_CANARY);
    expect(logged).not.toContain(QUO_SECRET);
  });

  it("does not emit a shape line for a current-format Quo message", async () => {
    const captured = { count: 0 };
    network.use(
      http.post(ROUTINE_URL, () => {
        captured.count += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    const raw = JSON.stringify({
      id: "EV-resource",
      apiVersion: "2026-03-30",
      type: "message.received",
      createdAt: "2026-04-13T12:00:00.000Z",
      data: {
        resource: {
          id: "AC-resource",
          direction: "incoming",
          text: BODY_CANARY,
          status: "received",
          createdAt: "2026-04-13T12:00:00.000Z",
        },
        context: {
          senderIdentifier: PHONE_CANARY,
          recipientIdentifiers: ["+15555550100"],
        },
      },
    });
    const { response, ctx } = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await settle(ctx);
    expect(captured.count).toBe(1);
    expect(diagLogs(logs.lines)).toEqual([]);
    expect(statusLogs(logs.lines)).toContainEqual(
      expect.objectContaining({ source: "quo", outcome: "forwarded", event_type: "message.received", message_id: "AC-resource" }),
    );
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
    expect(logs.lines.join("\n")).not.toContain(PHONE_CANARY);
  });

  it("does not log a shape when Quo verification fails or the route is not a verified POST", async () => {
    const raw = JSON.stringify({ type: "message.received", body: BODY_CANARY, from: PHONE_CANARY });
    const bad = await post(quoUrl(), raw, { "openphone-signature": SIG_CANARY });
    expect(bad.response.status).toBe(401);
    expect(await bad.response.json()).toEqual({ error: "unauthorized" });
    await settle(bad.ctx);

    const stale = await post(quoUrl(), raw, { "openphone-signature": await quoHeader(raw, QUO_SECRET, Date.now() - 6 * 60 * 1000) });
    expect(stale.response.status).toBe(401);
    await settle(stale.ctx);

    const wrong = await post(`https://relay.example/hook/wrong-token/quo`, raw, { "openphone-signature": await quoHeader(raw) });
    expect(wrong.response.status).toBe(404);
    await settle(wrong.ctx);

    const dormant = await post(quoUrl(), raw, {}, baseEnv({ QUO_WEBHOOK_SECRET: undefined }));
    expect(dormant.response.status).toBe(503);
    await settle(dormant.ctx);

    const get = await worker.fetch(new Request(quoUrl(), { method: "GET" }), baseEnv(), createExecutionContext());
    expect(get.status).toBe(404);

    const oversized = "x".repeat(1_000_001);
    const tooBig = await post(quoUrl(), oversized, { "openphone-signature": await quoHeader(oversized) });
    expect(tooBig.response.status).toBe(413);
    await settle(tooBig.ctx);

    expect(diagLogs(logs.lines)).toEqual([]);
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
    expect(logs.lines.join("\n")).not.toContain(PHONE_CANARY);
    expect(logs.lines.join("\n")).not.toContain(SIG_CANARY);
    expect(statusLogs(logs.lines).map((entry) => entry.outcome)).toEqual([
      "rejected_signature",
      "stale_timestamp",
      "rejected_path",
      "dormant",
      "rejected_path",
      "payload_too_large",
    ]);
  });

  it("logs one WhatsApp shape after a good signature and ignores an unsigned or dormant POST", async () => {
    const captured = { count: 0 };
    network.use(
      http.post(ROUTINE_URL, () => {
        captured.count += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "PN-100", display_phone_number: DIGITS_CANARY },
                contacts: [{ profile: { name: NAME_CANARY }, wa_id: DIGITS_CANARY }],
                messages: [
                  {
                    from: DIGITS_CANARY,
                    id: "wamid.text",
                    timestamp: "1710000000",
                    type: "text",
                    text: { body: BODY_CANARY },
                  },
                  {
                    from: DIGITS_CANARY,
                    id: "wamid.text-2",
                    timestamp: "1710000001",
                    type: "image",
                    image: { id: "media-canary", caption: BODY_CANARY, url: URL_CANARY, email: EMAIL_CANARY },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = await metaHeader(raw);
    const good = await post(whatsappUrl(), raw, { "X-Hub-Signature-256": signature });
    expect(good.response.status).toBe(200);
    expect(await good.response.json()).toEqual({ ok: true });
    await settle(good.ctx);
    expect(captured.count).toBe(2);
    expect(diagLogs(logs.lines)).toHaveLength(1);
    const diag = diagLogs(logs.lines)[0];
    expect(diag).toMatchObject({ relay: RELAY, diag: "payload_shape", source: "whatsapp", outcome: null, reason: null });
    const shape = diag.shape as ObjectShape;
    expect(shape.object).toBe("whatsapp_business_account");
    const change = asObject(asArray(asObject(asArray(shape.entry).array[0]).changes).array[0]);
    expect(change.field).toBe("messages");
    const value = asObject(change.value);
    expect(value.messaging_product).toBe("whatsapp");
    const messages = asArray(value.messages);
    expect(messages.length).toBe(2);
    expect(asObject(messages.array[0]).type).toBe("text");
    expect(asObject(asObject(messages.array[0]).text).body).toBe(`string(len=${BODY_CANARY.length})`);
    expect(statusLogs(logs.lines).map((entry) => entry.outcome).sort()).toEqual(["forwarded", "forwarded"]);

    const diagText = JSON.stringify(diag);
    for (const secret of [
      BODY_CANARY,
      NAME_CANARY,
      URL_CANARY,
      EMAIL_CANARY,
      DIGITS_CANARY,
      signature,
      AUTH_CANARY,
      WA_APP,
      "media-canary",
      "wamid.text",
      "PN-100",
    ]) {
      expect(diagText).not.toContain(secret);
    }
    const logged = logs.lines.join("\n");
    for (const secret of [BODY_CANARY, NAME_CANARY, URL_CANARY, EMAIL_CANARY, DIGITS_CANARY, signature, AUTH_CANARY, WA_APP, "media-canary"]) {
      expect(logged).not.toContain(secret);
    }

    const bad = await post(whatsappUrl(), raw, { "X-Hub-Signature-256": "sha256=deadbeef" });
    expect(bad.response.status).toBe(401);
    await settle(bad.ctx);
    const dormant = await post(whatsappUrl(), raw, {}, baseEnv({ WHATSAPP_APP_SECRET: "" }));
    expect(dormant.response.status).toBe(503);
    await settle(dormant.ctx);
    const handshake = await worker.fetch(
      new Request(`${whatsappUrl()}?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=challenge-token-9`),
      baseEnv(),
      createExecutionContext(),
    );
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toBe("challenge-token-9");
    expect(diagLogs(logs.lines)).toHaveLength(1);
    expect(logs.lines.join("\n")).not.toContain("deadbeef");
    expect(logs.lines.join("\n")).not.toContain(WA_VERIFY);
    expect(logs.lines.join("\n")).not.toContain("challenge-token-9");
  });

  it("logs an ignored statuses payload once and does not log Hospitable", async () => {
    const statuses = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [{ id: ID_CANARY, status: "read", recipient_id: DIGITS_CANARY }],
              },
            },
          ],
        },
      ],
    });
    const statusPost = await post(whatsappUrl(), statuses, { "X-Hub-Signature-256": await metaHeader(statuses) });
    expect(statusPost.response.status).toBe(200);
    expect(await statusPost.response.json()).toEqual({ ok: true });
    await settle(statusPost.ctx);
    expect(diagLogs(logs.lines)).toEqual([
      expect.objectContaining({ source: "whatsapp", outcome: "ignored", reason: "statuses" }),
    ]);
    expect(statusLogs(logs.lines)).toContainEqual(expect.objectContaining({ outcome: "ignored", reason: "statuses" }));
    expect(logs.lines.join("\n")).not.toContain(ID_CANARY);
    expect(logs.lines.join("\n")).not.toContain(DIGITS_CANARY);

    const captured = { count: 0 };
    network.use(
      http.post(ROUTINE_URL, () => {
        captured.count += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    const hospitable = JSON.stringify({
      id: "evt-shape",
      action: "message.created",
      data: {
        id: "msg-shape",
        sender_type: "guest",
        body: BODY_CANARY,
        sender: { first_name: NAME_CANARY },
      },
    });
    const hospitablePost = await post(`https://relay.example/hook/${PATH_TOKEN}/hospitable`, hospitable, {
      "CF-Connecting-IP": "38.80.170.10",
    });
    expect(hospitablePost.response.status).toBe(200);
    await settle(hospitablePost.ctx);
    expect(captured.count).toBe(1);
    expect(diagLogs(logs.lines)).toHaveLength(1);
    expect(logs.lines.join("\n")).not.toContain(BODY_CANARY);
    expect(logs.lines.join("\n")).not.toContain(NAME_CANARY);
  });

  it("logs an unparsed shape for invalid JSON without changing the status code", async () => {
    const quoRaw = "not-json";
    const quo = await post(quoUrl(), quoRaw, { "openphone-signature": await quoHeader(quoRaw) });
    expect(quo.response.status).toBe(400);
    expect(await quo.response.json()).toEqual({ error: "invalid_payload" });
    await settle(quo.ctx);
    expect(diagLogs(logs.lines)).toEqual([]);

    const waRaw = "{";
    const wa = await post(whatsappUrl(), waRaw, { "X-Hub-Signature-256": await metaHeader(waRaw) });
    expect(wa.response.status).toBe(200);
    expect(await wa.response.json()).toEqual({ ok: true });
    await settle(wa.ctx);
    expect(diagLogs(logs.lines)).toEqual([
      expect.objectContaining({
        source: "whatsapp",
        outcome: "invalid_payload",
        reason: null,
        shape: "unparsed",
      }),
    ]);
    expect(logs.lines.join("\n")).not.toContain("not-json");
  });
});
