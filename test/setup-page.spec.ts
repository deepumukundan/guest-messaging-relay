import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { authorizationValue } from "../src/lib";
import { network } from "./network";
import { settle, withQueue } from "./queue";

const PATH_TOKEN = "testpathtoken0123456789abcdefABCDEF";
const ROUTINE_URL = "https://routine.example/hooks/guest";

function relayEnv(extra: Partial<Env> = {}): Env {
  return withQueue({
    DEDUPE: env.DEDUPE,
    RELAY_PATH_TOKEN: PATH_TOKEN,
    RESPONDER_WEBHOOK_URL: ROUTINE_URL,
    RESPONDER_AUTH_HEADER: "crsr_bare-key",
    ENFORCE_HOSPITABLE_IP: "false",
    ...extra,
  });
}

async function get(path: string, testEnv: Env = relayEnv(), method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://relay.example${path}`, { method }), testEnv, ctx);
  await settle(ctx);
  return response;
}

describe("setup page", () => {
  it("serves the page at / without secrets, even before setup is complete", async () => {
    for (const testEnv of [relayEnv(), relayEnv({ RELAY_PATH_TOKEN: "short" })]) {
      const response = await get("/", testEnv);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Guest Messaging Relay");
      expect(html).not.toContain(PATH_TOKEN);
      expect(html).not.toContain(ROUTINE_URL);
      expect(html).not.toContain("crsr_bare-key");
    }
  });

  it("reports channel readiness only with the right relay password", async () => {
    const bare = await get(`/hook/${PATH_TOKEN}/status`);
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({
      relay: "ok",
      channels: { hospitable: true, quo: false, whatsapp: false },
    });

    const full = await get(
      `/hook/${PATH_TOKEN}/status`,
      relayEnv({ QUO_WEBHOOK_SECRET: "c2VjcmV0", WHATSAPP_VERIFY_TOKEN: "phrase", WHATSAPP_APP_SECRET: "app" }),
    );
    const body = await full.json();
    expect(body).toEqual({ relay: "ok", channels: { hospitable: true, quo: true, whatsapp: true } });
    expect(JSON.stringify(body)).not.toContain("c2VjcmV0");

    const halfWhatsapp = await get(`/hook/${PATH_TOKEN}/status`, relayEnv({ WHATSAPP_VERIFY_TOKEN: "phrase" }));
    expect(((await halfWhatsapp.json()) as { channels: { whatsapp: boolean } }).channels.whatsapp).toBe(false);

    expect((await get("/hook/wrongpassword0123456789abcdefABCDEF/status")).status).toBe(404);
    expect((await get(`/hook/${PATH_TOKEN}/status`, relayEnv(), "POST")).status).toBe(405);
    expect((await get(`/hook/${PATH_TOKEN}/status`, relayEnv({ RESPONDER_WEBHOOK_URL: "http://x" }))).status).toBe(500);
  });

  it("adds Bearer to a bare Grok Bot key and keeps a full header as is", async () => {
    expect(authorizationValue("crsr_abc")).toBe("Bearer crsr_abc");
    expect(authorizationValue("  crsr_abc  ")).toBe("Bearer crsr_abc");
    expect(authorizationValue("Bearer crsr_abc")).toBe("Bearer crsr_abc");

    const seen: (string | null)[] = [];
    network.use(
      http.post(ROUTINE_URL, ({ request }) => {
        seen.push(request.headers.get("authorization"));
        return HttpResponse.json({ ok: true });
      }),
    );
    const ctx = createExecutionContext();
    const event = {
      id: "evt-bearer",
      action: "message.created",
      data: { id: "msg-bearer", sender_type: "guest", source: "platform", body: "hi" },
    };
    const response = await worker.fetch(
      new Request(`https://relay.example/hook/${PATH_TOKEN}/hospitable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }),
      relayEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
    await settle(ctx);
    expect(seen).toEqual(["Bearer crsr_bare-key"]);
  });
});
