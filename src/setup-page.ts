/**
 * The setup page served at GET /. It holds no secrets. The visitor types the
 * relay password; the page calls GET /hook/<password>/status on this same
 * relay to check it, then shows each channel's webhook link with a Copy button.
 * Nothing is stored in the browser.
 */
export const SETUP_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Guest Messaging Relay setup</title>
<style>
  :root {
    --bg: #f7f7f5; --card: #ffffff; --text: #1d1d1b; --muted: #5f5f5a; --line: #e2e2dc;
    --accent: #2457d6; --ok: #1d7a46; --ok-bg: #e6f4ec; --warn: #8a5a00; --warn-bg: #fdf3dc;
    --bad: #b3261e; --bad-bg: #fbe9e7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161615; --card: #1f1f1e; --text: #ececea; --muted: #a3a39e; --line: #33332f;
      --accent: #7ea2ff; --ok: #6fd39b; --ok-bg: #173325; --warn: #f0c46a; --warn-bg: #3a2f14;
      --bad: #ff8a80; --bad-bg: #3d1d1a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 0; }
  p { margin: 8px 0; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-top: 20px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  input[type=password], input[type=text] { flex: 1 1 240px; min-width: 0; padding: 10px 12px; font: inherit;
    border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); }
  button { padding: 10px 16px; font: inherit; font-weight: 600; border: 0; border-radius: 8px;
    background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  .notice { border-radius: 8px; padding: 10px 12px; margin-top: 12px; }
  .ok { background: var(--ok-bg); color: var(--ok); }
  .warn { background: var(--warn-bg); color: var(--warn); }
  .bad { background: var(--bad-bg); color: var(--bad); }
  .channel-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: .85rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
  code.link { display: block; padding: 10px 12px; border-radius: 8px; background: var(--bg);
    border: 1px solid var(--line); word-break: break-all; font-size: .9rem; margin: 10px 0 8px; }
  ol { padding-left: 20px; margin: 8px 0 0; }
  li { margin: 4px 0; }
  a { color: var(--accent); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Guest Messaging Relay</h1>
  <p class="muted">Your relay is running. Type your relay password to check it and get your webhook links.</p>

  <section class="card">
    <form id="check">
      <label for="password">Relay password</label>
      <div class="row">
        <input id="password" type="password" autocomplete="off" spellcheck="false" placeholder="The password you chose when deploying">
        <button type="submit">Check</button>
      </div>
      <p class="muted"><label style="display:inline;font-weight:400"><input id="show" type="checkbox"> Show password</label></p>
    </form>
    <div id="result" class="notice" hidden></div>
  </section>

  <div id="channels" hidden>
    <section class="card" data-channel="hospitable">
      <div class="channel-head"><h2>1. Hospitable</h2><span class="badge"></span></div>
      <code class="link"></code>
      <button class="secondary copy" type="button">Copy link</button>
      <ol>
        <li>In Hospitable, go to <strong>Apps → Tools → Webhooks</strong> and add a new webhook.</li>
        <li>Name it <em>Guest Messaging Relay</em> and paste the link above as the URL.</li>
        <li>Select <strong>Messages</strong>, <strong>Reservations</strong>, and <strong>Reviews</strong>, then <strong>Save</strong>.</li>
        <li>Click <strong>Test</strong>. Your Grok Bot should receive a message.</li>
      </ol>
      <div id="protection" class="notice" hidden></div>
    </section>

    <section class="card" data-channel="quo">
      <div class="channel-head"><h2>2. Quo (optional)</h2><span class="badge"></span></div>
      <code class="link"></code>
      <button class="secondary copy" type="button">Copy link</button>
      <ol>
        <li>In Quo, create a webhook for <strong>message received</strong> on each number, using the link above.</li>
        <li>Copy the webhook's <strong>signing secret</strong>.</li>
        <li>In Cloudflare, add it as a secret named <code>QUO_WEBHOOK_SECRET</code> (<a href="#add-secret">how</a>).</li>
      </ol>
    </section>

    <section class="card" data-channel="whatsapp">
      <div class="channel-head"><h2>3. WhatsApp Business (optional)</h2><span class="badge"></span></div>
      <code class="link"></code>
      <button class="secondary copy" type="button">Copy link</button>
      <ol>
        <li>This needs a WhatsApp Business number connected to a Meta app. The regular WhatsApp app won't work.</li>
        <li>In Cloudflare, add a secret named <code>WHATSAPP_VERIFY_TOKEN</code> with any phrase you make up (<a href="#add-secret">how</a>).</li>
        <li>Add another named <code>WHATSAPP_APP_SECRET</code> with your Meta app's secret (<strong>App settings → Basic → App secret</strong>).</li>
        <li>Reload this page and check again. WhatsApp should say <em>Ready</em>.</li>
        <li>In your Meta app, open <strong>WhatsApp → Configuration</strong>. Paste the link above as the callback URL, enter the same phrase as the verify token, and subscribe to <strong>messages</strong>.</li>
      </ol>
    </section>

    <section class="card" id="add-secret">
      <h2>Adding a secret in Cloudflare</h2>
      <ol>
        <li>Open <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener noreferrer">Workers &amp; Pages in Cloudflare</a> and click your relay.</li>
        <li>Go to <strong>Settings → Variables and Secrets</strong> and click <strong>Add</strong>.</li>
        <li>Choose type <strong>Secret</strong>, enter the name and value, and click <strong>Deploy</strong>.</li>
      </ol>
    </section>
  </div>
</main>
<script>
(function () {
  var form = document.getElementById("check");
  var input = document.getElementById("password");
  var show = document.getElementById("show");
  var result = document.getElementById("result");
  var channels = document.getElementById("channels");

  show.addEventListener("change", function () { input.type = show.checked ? "text" : "password"; });

  function say(kind, text) {
    result.className = "notice " + kind;
    result.textContent = text;
    result.hidden = false;
  }

  function badge(section, ready, readyText, waitingText) {
    var el = section.querySelector(".badge");
    el.textContent = ready ? readyText : waitingText;
    el.className = "badge " + (ready ? "ok" : "warn");
  }

  function protection(p) {
    var el = document.getElementById("protection");
    if (p.hospitable_ip_check === false) {
      el.className = "notice bad";
      el.textContent = "The Hospitable IP check is off, so anyone with this link can post to it. Remove ENFORCE_HOSPITABLE_IP in Cloudflare unless a proxy sits in front of the relay.";
    } else if (p.hospitable_signature === true) {
      el.className = "notice ok";
      el.textContent = "Protection: only Hospitable's servers, with your signing secret, can use this link.";
    } else {
      el.className = "notice warn";
      el.textContent = "Protection: only Hospitable's servers can use this link. For extra protection, add Hospitable's signing secret as HOSPITABLE_WEBHOOK_SECRET (see the README's Security section).";
    }
    el.hidden = false;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var password = input.value.trim();
    channels.hidden = true;
    if (!password) { say("bad", "Type your relay password first."); return; }
    say("warn", "Checking…");
    var base = location.origin + "/hook/" + encodeURIComponent(password) + "/";
    fetch(base + "status", { cache: "no-store" })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (answer) {
        if (answer.status === 200 && answer.body.relay === "ok") {
          say("ok", "Password is correct. Your relay is ready. Connect your channels below.");
          var ch = answer.body.channels || {};
          document.querySelectorAll("[data-channel]").forEach(function (section) {
            var name = section.getAttribute("data-channel");
            section.querySelector(".link").textContent = base + name;
            var ready = ch[name] === true;
            badge(section, ready, "Ready", name === "hospitable" ? "Ready" : "Needs a secret");
          });
          protection(answer.body.protection || {});
          channels.hidden = false;
        } else if (answer.status === 404) {
          say("bad", "That password doesn't match this relay. Check for typos, or copy it again from your password manager.");
        } else if (answer.body && answer.body.error === "misconfigured") {
          say("bad", "The relay's settings aren't complete. In Cloudflare, check that the relay password is at least 32 letters and numbers (no symbols), the webhook URL starts with https://, and the authorization value is filled in.");
        } else {
          say("bad", "Something went wrong (status " + answer.status + "). Try again in a minute.");
        }
      })
      .catch(function () { say("bad", "Couldn't reach the relay. Check your internet connection and try again."); });
  });

  document.querySelectorAll(".copy").forEach(function (button) {
    button.addEventListener("click", function () {
      var text = button.parentElement.querySelector(".link").textContent;
      var done = function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy link"; }, 1500); };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy this link:", text); });
      } else {
        window.prompt("Copy this link:", text);
      }
    });
  });
})();
</script>
</body>
</html>
`;
