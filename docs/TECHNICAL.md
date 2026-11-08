# Technical reference

This is the detailed reference for guest-messaging-relay. For setup, see the [README](../README.md) (people) or [AGENTS.md](../AGENTS.md) (AI agents).

The relay is a receive-only Cloudflare Worker. Hospitable, Quo, and WhatsApp guest messages are normalized and POSTed to a Grok Bot routine webhook. The Worker never calls a send-message API. It does not map lines to properties; the responder bot does that.

Deploying is done by Cloudflare, either with the Deploy to Cloudflare button or from your own computer (section 3). GitHub Actions ([`.github/workflows/test.yml`](../.github/workflows/test.yml)) only runs the typecheck and tests.

## 1. Request flow

```mermaid
flowchart LR
  Hospitable[Hospitable] -->|1. guest message| Relay[Cloudflare Guest Messaging Relay]
  Quo[Quo] -->|1. guest message| Relay
  WhatsApp[WhatsApp Cloud API] -->|1. guest message| Relay
  Relay -->|2. queued| Queue[(Delivery queue)]
  Queue --> Consumer[Queue handler]
  Consumer -->|3. forwarded| Bot[Grok Bot routine]
  Consumer -. after 20 retries .-> DLQ[(Dead-letter queue)]
  Bot -.->|4. reply via MCP| Hospitable
  Bot -.->|4. reply via MCP| Quo
  Bot -.->|4. reply via MCP| WhatsApp
```

Every exchange starts with step 1, a guest message arriving from a channel. Replies (step 4, dotted) do not pass through the relay. The bot sends them through its own MCP connections to each service.

1. A channel POSTs to `/hook/<RELAY_PATH_TOKEN>/...`.
2. The Worker checks the path token, and the channel's signature when that channel is configured.
3. It checks the dedupe store (KV). A message id already forwarded in the last 24 hours is answered with **200** and not queued again.
4. Each guest message becomes one job on the `DELIVERY` queue. Only after the queue accepts the job does the Worker answer **200**. If the queue rejects it, the Worker answers **500** and the channel retries.
5. The queue handler POSTs the job to `RESPONDER_WEBHOOK_URL` with `Authorization` set to `RESPONDER_AUTH_HEADER`.
6. After the bot returns 2xx, the dedupe key is stored in KV for 24 hours.

Reviews and reservation creates/changes from Hospitable are forwarded too, in Hospitable's own shape, not the normalized message shape.

Logs are one JSON status line per decision: `relay`, `source`, `outcome`, and ids. They do not include message text, names, or full phone numbers.

Cloudflare's automatic invocation logs and traces are off in `wrangler.jsonc` (`observability.logs.invocation_logs: false`, `observability.traces.enabled: false`). Both record the request URL, and every webhook URL contains `RELAY_PATH_TOKEN`. Turning them back on writes the relay password into Workers Logs. Live `wrangler tail` still shows URLs to whoever runs it.

### Setup page and status check

- **`GET /`** serves a static setup page ([src/setup-page.ts](../src/setup-page.ts)). It contains no secrets and is served even before the required secrets are set. Headers: a strict Content-Security-Policy (`connect-src 'self'`, `frame-ancestors 'none'`), `no-store`, and `no-referrer`.
- **The page** asks for the relay password and calls `GET /hook/<password>/status` on the same relay. It never stores the password.
- **`GET /hook/<token>/status`** answers `{"relay":"ok","channels":{"hospitable":true,"quo":bool,"whatsapp":bool},"protection":{"hospitable_ip_check":bool,"hospitable_signature":bool}}`, which says only whether each channel's secrets are set and which optional Hospitable checks are on. The page shows the protection level under the Hospitable link. A wrong token gets **404**, a non-GET request gets **405**, and incomplete settings get **500**.

## 2. Delivery, retries, and limits

- **Retries.** A failed POST (non-2xx, network error, or no answer within 30 seconds) is retried by Cloudflare Queues. The delay is 60 seconds, then doubles each time up to one hour (`retryDelaySeconds` in `src/index.ts`). After `max_retries` (20) the job moves to the dead-letter queue `guest-messaging-relay-delivery-dlq`. The 20 retries span about 15 hours.
- **Keep the numbers in sync.** `max_retries` in `wrangler.jsonc` must match `MAX_DELIVERY_RETRIES` in `src/index.ts`.
- **Duplicates.** The queue handler checks the dedupe key again before posting, so two copies of a message queued close together are forwarded once. Queues guarantees at-least-once delivery, so the bot should still ignore a `message_id` it has already handled.
- **Oversized jobs.** Queue messages are capped at 128 KB. A job over 120 KB (in practice, only a very large Hospitable reservation) skips the queue and is POSTed once directly, best effort. The log line is `queue_bypassed_size`.
- **Consumer batching.** `max_batch_size` is 10 and `max_batch_timeout` is 1 second, so a message normally reaches the bot within about a second.

Limits on the Workers Free plan:

| Resource | Free plan | Use per forwarded message |
| --- | --- | --- |
| KV writes | 1,000 / day | 1 (dedupe key). **This is the tightest limit: about 1,000 forwarded items a day.** Past it, forwarding continues but dedupe keys are not stored until the reset at 00:00 UTC. |
| KV reads | 100,000 / day | 2 |
| Queues operations | 10,000 / day | About 3, plus 1 per retry |
| Queue retention | 24 hours, fixed | Jobs older than that are dropped |
| Worker requests | 100,000 / day | 1 webhook request plus queue handler runs |

See [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) and [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

## 3. Deploying

### Deploy to Cloudflare button

The README's button:
- Copies this repository into the user's GitHub account.
- Creates the KV namespace and the delivery queue, and writes the new KV id into the copy's `wrangler.jsonc`. Cloudflare creates the dead-letter queue on the first deploy.
- Asks for the secrets left uncommented in [`.dev.vars.example`](../.dev.vars.example), with help text from `cloudflare.bindings` in `package.json`.
- Sets up Workers Builds, so every push to the copy's main branch redeploys it.

The button needs default resource names and ids to replace, so `wrangler.jsonc` keeps the author's KV id. A copy gets its own namespace and id. Queue names are fixed. Two relays in one account need different queue names, because a queue can have only one consumer.

The copy starts as a single commit, and it doesn't include `.github/workflows`, so tests don't run on GitHub in a copy. `workers_dev` is on because the setup page and webhook links use the `workers.dev` address. `preview_urls` is off, so test versions don't get their own address.

### Deploy from your own computer

For developers and local AI agents. Run these from a clone of the repository. `wrangler login` opens a browser for the Cloudflare login, so no API token is needed.

```sh
npm ci
npx wrangler login
npx wrangler kv namespace create DEDUPE   # copy the printed id into wrangler.jsonc
npx wrangler queues create guest-messaging-relay-delivery
npx wrangler secret put RELAY_PATH_TOKEN
npx wrangler secret put RESPONDER_WEBHOOK_URL
npx wrangler secret put RESPONDER_AUTH_HEADER
npx wrangler deploy
```

`wrangler secret put` asks for each value with hidden input. On a Worker that doesn't exist yet, it creates the Worker so the secret has somewhere to go. Run `npm test` and `npm run typecheck` before deploying changes.

For local development, copy `.dev.vars.example` to `.dev.vars` and run `npm run dev`. Because `wrangler.jsonc` declares `secrets.required`, `wrangler dev` loads only those three keys from `.dev.vars`. Channel secrets therefore show as not ready on the local setup page.

## 4. Worker secrets

Set secrets in the Cloudflare dashboard (**Workers & Pages → your relay → Settings → Variables and Secrets**, type **Secret**) or with `npx wrangler secret put NAME`. See [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

- **Required ones.** `wrangler.jsonc` lists the three required secrets under `secrets.required`, so `wrangler deploy` fails until they exist.
- **Redeploys keep secrets.** A redeploy (including Workers Builds) does not delete secrets.
- **Plain-text variables don't survive.** A redeploy *does* remove plain-text variables added in the dashboard, so add `ENFORCE_HOSPITABLE_IP` as type **Secret** too.

| Secret | Required | When it is missing |
| --- | --- | --- |
| `RELAY_PATH_TOKEN` | Yes | Every request is **500**. Also **500** if it is shorter than 32 characters or has anything but letters and digits. |
| `RESPONDER_WEBHOOK_URL` | Yes | Every request is **500**. Also **500** if it is not an `https://` URL. |
| `RESPONDER_AUTH_HEADER` | Yes | Every request is **500**. |
| `QUO_WEBHOOK_SECRET` | For Quo | `POST /hook/<token>/quo` is **503**. |
| `WHATSAPP_VERIFY_TOKEN` | For WhatsApp | Both WhatsApp methods are **503** if either WhatsApp secret is unset. |
| `WHATSAPP_APP_SECRET` | For WhatsApp | Same as the verify token. |
| `HOSPITABLE_WEBHOOK_SECRET` | No | Signature check is skipped. When set, `Signature` must be the hex HMAC-SHA256 of the raw body. |
| `ENFORCE_HOSPITABLE_IP` | No | The Hospitable IP check stays on. Only the exact value `false` turns it off. |

Generate `RELAY_PATH_TOKEN` with `openssl rand -hex 32` or a password manager (letters and digits only, 32 or more). It is one URL path segment.

## 5. Responder bot

In Grok Bot, create a routine whose trigger is a webhook. That trigger gives you a webhook URL and an Authorization header value.

- `RESPONDER_WEBHOOK_URL` is that URL.
- `RESPONDER_AUTH_HEADER` is the routine's key (`crsr_...`). A value with no space gets `Bearer ` added (`authorizationValue` in `src/lib.ts`). A full header such as `Bearer crsr_...` is used as is.
- Both values are in the Grok Bot app (desktop or phone): open the bot, then **Details**, then the routine that runs **When a webhook fires**, then the **Webhook** section at the bottom. **POST to** is the URL and **key** is the key; the **header** row is the same key with `Bearer ` in front.

## 6. Hospitable

Webhook URL:

```text
https://<worker>.<account-subdomain>.workers.dev/hook/<RELAY_PATH_TOKEN>/hospitable
```

`POST /hook/<RELAY_PATH_TOKEN>` is the same handler. See [Webhooks for Reservations, Properties, Messages, and Reviews](https://help.hospitable.com/en/articles/10008203-webhooks-for-reservations-properties-messages-and-reviews). Point it at message, reservation, and review events. Property events are acknowledged and not forwarded.

By default `CF-Connecting-IP` must be in `38.80.170.0/24`, Hospitable's published source range. Set `ENFORCE_HOSPITABLE_IP` to the exact string `false` only if a proxy replaces that header.

Guest messages are forwarded only when `data.sender_type` is `guest` and `data.source` is not `automated`, `AI`, `public_api`, or `hospitable`. `sender_role` is ignored. `review.created`, `reservation.created`, and `reservation.changed` are forwarded on their own, keyed on the webhook event id. Other actions return **200** and are not forwarded.

## 7. Quo

Create a webhook for `message.received` on each line you want. See [Webhooks](https://support.quo.com/core-concepts/integrations/webhooks) and [Validate webhook signatures](https://www.quo.com/docs/2026-03-30/webhooks-signature-validation). Put the signing secret in `QUO_WEBHOOK_SECRET`.

- **Current webhooks** use a `whsec_` secret and the headers `webhook-id`, `webhook-timestamp` (unix seconds), and `webhook-signature` (`v1,<base64>`, space-separated). The signature is HMAC-SHA256 over `id.timestamp.` plus the raw body. The Worker strips one `whsec_` prefix and base64-decodes the rest.
- **Older webhooks** use `openphone-signature: hmac;1;<timestamp>;<base64>` and a bare base64 secret. A 13-digit timestamp is milliseconds.

Either valid scheme is accepted. A timestamp more than 5 minutes off is **401**.

Every `message.received` with `direction` `incoming` is forwarded, from any line. Other event types, including `message.delivered`, return **200** and are not forwarded.

Current payloads (API version `2026-03-30`) put the message on `data.resource` (`id`, `direction`, `text`, `createdAt`, `status`) and the parties on `data.context`. `sender.phone` is `senderIdentifier`. `inbox` is the first E.164 value in `recipientIdentifiers`. `phoneNumberId` is not the inbox. See [Webhook event payloads](https://www.quo.com/docs/2026-03-30/webhooks-event-payloads).

Older payloads put the message on `data.object` (`from`, `to`, `body` or `text`, `direction`). `to` may be a string or an array. Those fields are used when they normalize to an E.164 number, including when a payload also has `data.resource`.

A missing or unusable context still forwards the text when the event is an incoming `message.received` with a message id. `inbox` and `sender.phone` are omitted in that case. `created_at` is `data.resource.createdAt` or `data.object.createdAt`, then the envelope `createdAt`.

## 8. WhatsApp

In the Meta app, subscribe to WhatsApp `messages` and set the callback URL:

```text
https://<worker>.<account-subdomain>.workers.dev/hook/<RELAY_PATH_TOKEN>/whatsapp
```

Use the same string for Meta's verify token and `WHATSAPP_VERIFY_TOKEN`. Put the app secret in `WHATSAPP_APP_SECRET`. See [Getting started with webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/). Both secrets must be on the Worker before you save the callback URL in Meta, or the handshake gets **503**.

Apps made with the **Connect with customers through WhatsApp** use case keep this under **Use cases → Customize → Configuration**. Meta notes that some webhooks are not sent while an app is in Dev mode, so publish it (Live) before relying on real guest traffic. See [WhatsApp webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/).

- **Handshake.** `GET` with `hub.mode=subscribe` and a matching `hub.verify_token` returns `hub.challenge` as text.
- **Messages.** `POST` requires `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`.
  - Text messages are forwarded.
  - Other types are forwarded with an empty body plus `media_type` and `media_id`. Captions and button replies are not included.
  - Status receipts are ignored.
  - A message id repeated within one batch is queued once.
  - If any dedupe read fails, the whole batch gets **500** before anything is queued, so Meta redelivers it.

No WhatsApp access token is stored; this Worker only receives.

## 9. Normalized payload

Quo and WhatsApp messages, and the extra fields on a Hospitable guest message, look like this (fake data).

Quo. `inbox` is the receiving line. There is no `property` field.

```json
{
  "source": "quo",
  "event_type": "message",
  "inbox": "+15555550100",
  "sender": { "phone": "+15555550103" },
  "message_id": "AC-example",
  "body": "Hello",
  "created_at": "2024-01-01T00:00:00.000Z"
}
```

Hospitable keeps `event_type` as `message.created` plus its slim fields (`message_id`, `property_id`, `property_name`, and the rest), so an existing routine still sees them. `property` is included only when Hospitable sent a property name. `inbox` is the string `hospitable`.

```json
{
  "source": "hospitable",
  "event_type": "message.created",
  "inbox": "hospitable",
  "sender_type": "guest",
  "message_id": "msg-example",
  "property_id": "prop-example",
  "property_name": "Example Cabin",
  "property": "Example Cabin",
  "body": "Hello",
  "sender": { "first_name": "Ada" }
}
```

`body` is at most 4000 characters. `truncated` is present and `true` only when the text was cut. `sender.phone`, `sender.id`, and `sender.first_name` are omitted when they do not apply. WhatsApp `inbox` is `metadata.phone_number_id`. WhatsApp and Quo omit `property`.

Reservation and review events forward Hospitable's own object (`reservation` or `review`), including the guest's contact details. Reservation `properties` are trimmed to id, names, timezone, check-in/out, capacity, and house rules.

## 10. Testing and troubleshooting

```sh
npm ci
npm test
npm run typecheck
```

- **Dry run.** `npx wrangler deploy --dry-run --outdir dist` builds a bundle and does not deploy.
- **Queue in tests.** The tests replace the `DELIVERY` queue with an in-memory stand-in (`test/queue.ts`). `settle(ctx)` waits for the request, then runs the queue handler over what it queued. `drainQueue()` runs one more delivery round for retried jobs.
- **Regenerate types** with `npm run types` after changing bindings in `wrangler.jsonc`.
- **Entry module exports.** `src/index.ts` exports only the default handler. Cloudflare's runtime rejects a main module that exports constants or plain functions, and tests don't catch it, so shared values go in `src/lib.ts`. `npm run dev` does catch it.

| Situation | Status |
| --- | --- |
| Path or token does not match | **404** |
| Hospitable path, method is not POST | **405** |
| Required secret missing or invalid (short relay password, non-https bot URL) | **500** |
| Dedupe store unreadable (the sender retries) | **500** |
| Queue rejected the job (the sender retries) | **500** |
| Quo signing secret unset | **503** |
| Either WhatsApp secret unset | **503** |
| Bad or stale signature | **401** |
| Event ignored, duplicate, or not a guest message | **200**, nothing forwarded |
| Accepted | **200** once queued; the bot POST happens in the queue handler |

Each log line is JSON with `relay` set to `guest-messaging-relay`.

- **`outcome`** is the decision:
  - Request side: `ignored`, `duplicate`, `misconfigured`, `dormant`, `rejected_path`, `rejected_signature`, `stale_timestamp`, `queue_failed`, `queue_bypassed_size`.
  - Queue handler: `forwarded`, `forward_failed`, `duplicate`, `dedupe_write_failed`.
- **`attempt`** is the queue delivery attempt, starting at 1.
- **`routine_status`** is the bot's HTTP status, or `0` for a network error or timeout.

The line does not include the message, the guest's name, or a full phone number.

### Temporary payload-shape diagnostics

While `SHAPE_DIAGNOSTICS` is `true` in [src/shape-diagnostics.ts](../src/shape-diagnostics.ts), a verified POST from a source listed in `SHAPE_DIAGNOSTICS_SOURCES` adds one extra JSON line: `diag` is `payload_shape`, plus `source`, `outcome`, `reason`, and `shape`. Quo is no longer in that set. WhatsApp still is, until its first live tests. `shape` is field names and JSON types. A few enum keys (`type`, `direction`, `status`, `apiVersion`, and the other names in that file) include the value only when it is a short token. Message text, names, phone numbers, emails, ids, URLs, headers, and secrets are not logged. Rejected requests, Hospitable, and the WhatsApp handshake do not emit the line. `outcome` is null when the POST was accepted for delivery; the queue line still reports `forwarded` or `forward_failed`. Delete the module and its call sites after the WhatsApp samples are captured.

## 11. Security model

### Checks in the Worker

| Layer | What it stops | Where |
| --- | --- | --- |
| Path token | Anyone without the link. Constant-time compare; 32+ letters and digits (190+ bits for the suggested 40), so guessing is not practical. Wrong token is **404** before any KV, queue, or body read. | `matchRoute` |
| Hospitable source IP | Requests not from `38.80.170.0/24`. `CF-Connecting-IP` is set by Cloudflare and can't be forged by the client. Checked before the body is read. | `isHospitableSourceIp` |
| Hospitable signature (optional) | Another Hospitable account, or anything else inside Hospitable's range, posting to a leaked link. On only when `HOSPITABLE_WEBHOOK_SECRET` is set. | `verifySignature` |
| Quo signature + 5-minute window | Forged and old replayed requests. Always required; no secret means **503**. | `verifyQuoRequest` |
| Meta signature | Forged WhatsApp requests. Always required; either secret missing means **503**. | `verifyMetaSignature` |
| Body cap (1 MB), text cap (4000 chars) | Memory and queue abuse. | `readBoundedBody`, `capText` |
| Dedupe (24 h) | A replayed message reaching the bot twice within a day. WhatsApp and Hospitable signatures carry no timestamp, so a captured request replayed after 24 hours would be forwarded again; capturing one needs a break in TLS. | KV `DEDUPE` |

Rejected requests never touch KV, the queue, or the bot, so junk traffic can't use up those quotas or reach the bot. The bot only ever receives the relay's own JSON, never the raw request.

### Denial of service

- **Volumetric attacks** are absorbed by Cloudflare's automatic DDoS protection, which covers `workers.dev`.
- **Request floods** that get past it still run the Worker, which rejects them cheaply. On the Workers Free plan they count toward the 100,000 requests a day; once that is spent, the relay answers with an error until 00:00 UTC and the channels' own retries carry the backlog. On Free a flood can't cost money; on Paid every request is billed.
- **A Workers rate-limit binding is not used.** It runs inside the Worker, so the request has already been counted, and rejected requests already do no costly work. The defence that saves the quota is a WAF rule at the edge.
- **Edge rules need a zone.** `workers.dev` can't have WAF custom rules or rate-limiting rules. The steps in [Own domain and firewall rules](#own-domain-and-firewall-rules) move the relay to a Custom Domain on the user's zone (`routes` with `custom_domain: true`), adds three custom rules (relay paths only, GET/HEAD/POST only, Hospitable path only from `38.80.170.0/24`) and one rate-limiting rule on `/hook/`, then sets `workers_dev` to `false` so the edge rules can't be bypassed. `workers_dev` in `wrangler.jsonc` is applied on every deploy, so turning `workers.dev` off in the dashboard alone is undone by the next build.
- **Challenges break webhooks.** "I'm Under Attack" mode, Bot Fight Mode, and managed challenges on the relay's hostname would stop Hospitable, Quo, and Meta, which can't run JavaScript challenges.

### Own domain and firewall rules

The `workers.dev` address can't have firewall rules. If you have a domain on Cloudflare (the free plan is enough), Cloudflare's firewall can block junk requests at the edge, so they never use up the relay's daily requests. Do these in order, so no messages are lost while you switch.

1. **Add a relay address on your domain.** In your relay's GitHub repository, open `wrangler.jsonc`, click the pencil icon, and add this line below `"workers_dev": true,`, using your own domain:

   ```jsonc
   "routes": [{ "pattern": "relay.yourdomain.com", "custom_domain": true }],
   ```

   Click **Commit changes**. Cloudflare redeploys the relay in a minute or two.
2. **Move your channels to the new address.** Open `https://relay.yourdomain.com`, check your password, and copy each link into Hospitable, Quo, and your Meta app in place of the old one. Test each channel.
3. **Add firewall rules.** In Cloudflare, open your domain, then **Security → WAF → Custom rules**, and create these. For each, click **Edit expression**, paste the expression, choose **Block**, and **Deploy**.

   | Rule name | Expression |
   | --- | --- |
   | Relay: only relay paths | `(http.host eq "relay.yourdomain.com" and not (http.request.uri.path eq "/" or starts_with(http.request.uri.path, "/hook/")))` |
   | Relay: only GET and POST | `(http.host eq "relay.yourdomain.com" and not http.request.method in {"GET" "HEAD" "POST"})` |
   | Relay: Hospitable only from Hospitable | `(http.host eq "relay.yourdomain.com" and ends_with(http.request.uri.path, "/hospitable") and not ip.src in {38.80.170.0/24})` |

4. **Add a rate limit.** Under **Security → WAF → Rate limiting rules**, create a rule for requests where **Hostname** equals `relay.yourdomain.com` and **URI Path** starts with `/hook/`, counted by **IP**, at more than **50 requests per 10 seconds**, with action **Block** for the shortest time offered. If your plan offers fewer choices, pick the closest ones.
5. **Turn off the old address.** Once every channel works on the new address, edit `wrangler.jsonc` again, change `"workers_dev": true` to `"workers_dev": false`, and commit. The `workers.dev` address then stops answering, so nobody can go around your firewall rules. Your setup page is now at `https://relay.yourdomain.com`.

### What a leaked relay password allows

With the link alone, an attacker can read the status endpoint (which channels are set up; no secret values) and pass the WhatsApp verify handshake only if they also know `WHATSAPP_VERIFY_TOKEN`. They still can't get a message to the bot: Hospitable needs Hospitable's IP range (and the signing secret, when set), Quo needs the Quo signing secret, and WhatsApp needs the Meta app secret. Rotate `RELAY_PATH_TOKEN` and update each channel's link anyway.
