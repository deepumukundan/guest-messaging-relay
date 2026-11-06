# AGENTS.md

Instructions for AI agents working with this repository. There are two jobs:

- **Help a human set up the relay.** This is the usual job. See [Guiding a setup](#guiding-a-setup).
- **Change the code.** See [Working on the code](#working-on-the-code).

## What this is

A Cloudflare Worker that receives guest messages from Hospitable, Quo, and WhatsApp webhooks and forwards them to the human's Grok Bot routine webhook. The bot replies to guests through its own MCP connections, not through this relay. It runs on Cloudflare's free plan.

## Guiding a setup

Setup is done in the human's web browser with the **Deploy to Cloudflare** button. No terminal, GitHub CLI, or API token is needed. Your job is to walk the human through [README.md](README.md) one step at a time, explain anything unclear, and check each result with them. If you can control a browser, you may click through pages for them, but the human logs in.

### Rules

1. **Never handle secret values.** Don't ask the human to paste a secret into the chat, and don't generate one in the chat. That includes the relay password, the bot's webhook URL and authorization value, the Quo signing secret, the Meta app secret, and logins. The human types them straight into Cloudflare.
2. **Relay password.** Ask the human to have their password manager generate 40 letters and numbers with no symbols, and to save it there. The relay refuses passwords shorter than 32 characters or containing symbols.
3. **Links.** The setup page builds the webhook links, so the human never types them. Don't write them out with the password in the chat.
4. **Change nothing else** in the human's Cloudflare or GitHub accounts. Delete nothing.

### Steps

1. **Before starting,** confirm the human has a Cloudflare account and a GitHub account (both free). Ask which channels they use: Hospitable, Quo, WhatsApp, or several.
   - They need a paid Grok Bot plan, and their Grok Bot routine's webhook URL and key. In the Grok Bot app (desktop or phone), they open the bot, then the **Details** tab, then the routine that runs **When a webhook fires**. They scroll to the **Webhook** section at the bottom, where **POST to** is the URL and **key** is the key. The relay adds `Bearer` itself, so the **header** row isn't needed.
2. **Deploy** (README step 1).
   - The human clicks the button, logs in to Cloudflare, picks a `workers.dev` subdomain if asked, and connects GitHub.
   - **Project name:** keep `guest-messaging-relay`. If Cloudflare says a repository with that name already exists (they already have a copy or a fork), add a suffix such as `-2`. The project name becomes the Worker's name and the start of its address. Keep the suggested KV namespace and Queue names.
   - They fill in the three fields and click **Deploy**.
3. **Open the setup page** (README step 2).
   - The human opens the relay address. It ends in `workers.dev` and is not secret.
   - They type the relay password and click **Check**. A green message means it works, and the page then shows each channel's webhook link with a **Copy** button and a Ready badge.
   - If the page reports a problem, use the README's "Something not working?" section.
4. **Connect channels** (README step 3), only the ones they use. Start with Hospitable: **Apps → Tools → Webhooks**, add a webhook with the copied link, select Messages, Reservations, and Reviews, **Save**, then **Test**.
   - **WhatsApp:** this works only with a WhatsApp Business number connected to a Meta app (WhatsApp Cloud API). The regular WhatsApp app, or the WhatsApp Business app on its own, can't send webhooks. Both WhatsApp secrets must be added before the human saves the callback URL in Meta. The setup page shows **Ready** once they are.
   - **Quo:** the signing secret appears after the webhook is created, so the order is webhook first, then the secret.
   - New secrets are added in Cloudflare under **Workers & Pages → their relay → Settings → Variables and Secrets** as type **Secret**, then **Deploy**.
5. **Test.** Ask the human to send a message to one of their numbers. The bot should get it within seconds. If not, have them read the `outcome` field under **Logs** for the Worker, and use the table in [README.md](README.md#something-not-working).
6. **Protection** (README "Security" section). Offer the recommended steps: the Hospitable signing secret (`HOSPITABLE_WEBHOOK_SECRET`, then **Test**; remove it again if logs show `rejected_signature`), staying on the Workers Free plan, and leaving "I'm Under Attack" mode and Bot Fight Mode off for the relay. The own-domain firewall setup is optional and only for humans who already have a domain on Cloudflare. Follow its order exactly: add the custom domain, move every channel to the new links and test them, add the rules, and only then set `workers_dev` to `false`. Doing these is the human's choice; they make the changes themselves.

### If the deploy fails

Ask the human to open **Workers & Pages → their relay → Deployments** (or the build log the button shows) and read you the error. Don't ask for any secret values.

- **Missing required secrets:** a field from step 1 was left empty. Add it as a secret and deploy.
- **Subdomain error:** they need to choose a `workers.dev` subdomain under **Workers & Pages**.
- **A KV namespace or queue already exists:** an earlier relay is in the account. Ask whether to remove the old one (they do it in the dashboard) or pick different names on Cloudflare's deploy page.

People comfortable with a terminal can deploy from their own computer instead. See [docs/TECHNICAL.md](docs/TECHNICAL.md#deploy-from-your-own-computer).

## Working on the code

- **Code.** The Worker is [src/index.ts](src/index.ts). The setup page is [src/setup-page.ts](src/setup-page.ts), and shared constants and helpers are in [src/lib.ts](src/lib.ts). Tests are in [test/](test/).
- **Entry-module exports.** `src/index.ts` may export only the default handler (and types). Cloudflare's runtime refuses to start a Worker whose main module exports constants or plain functions. Put shared values in `src/lib.ts`.
- **Checks.** Run `npm ci`, `npm test`, and `npm run typecheck` before you finish. GitHub runs the same checks on every push ([.github/workflows/test.yml](.github/workflows/test.yml)).
- **Bindings.** After changing bindings in `wrangler.jsonc`, run `npm run types` to regenerate `worker-configuration.d.ts`.
- **Retries.** `max_retries` in `wrangler.jsonc` must equal `MAX_DELIVERY_RETRIES` in `src/index.ts`.
- **Logs.** Never log message text, guest names, or full phone numbers. The tests check this with canary values.
- **Tests and the queue.** Tests use an in-memory queue ([test/queue.ts](test/queue.ts)). Use `settle(ctx)` after a request, and `drainQueue()` for another delivery round.
- **Setup form.** The Deploy to Cloudflare button asks for the uncommented values in `.dev.vars.example`. Their help text is under `cloudflare.bindings` in `package.json`. Keep both in step with the README.
- **Docs.** Update [docs/TECHNICAL.md](docs/TECHNICAL.md) when behavior changes, and this file and the README when setup changes.
