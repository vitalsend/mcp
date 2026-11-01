// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// The one page the package shows the user: confirm a send, read the password,
// share the link. Served on 127.0.0.1 at a random path that is never given to
// the client or the model, opened in the user's browser by the package itself.
// It talks only to this process; nothing reaches VitalSend from here.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { SHARE_ROUTES, shareText, shareUrl } from '../vendor/vitalsend-share.js';

const STYLE = `body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
.card{border:1px solid #ccc;border-radius:1rem;padding:1.5rem}code{display:block;font-size:1.4rem;letter-spacing:.15em;margin:1rem 0;word-break:break-all}
.row{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}a,button{padding:.5rem .9rem;border-radius:.5rem;border:1px solid #888;background:none;color:inherit;text-decoration:none;font:inherit;cursor:pointer}
.dim{opacity:.4}.primary{background:#111;color:#fff}[hidden]{display:none}`;

const SCRIPT = `(() => {
const base = location.pathname;
const $ = (id) => document.getElementById(id);
const post = (action) => fetch(base + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
const labels = { sms: 'SMS', whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'Email' };
function shares(el, item, s) {
  el.textContent = '';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.onclick = () => navigator.clipboard?.writeText(item === 'password' ? s.password.value : s.link.value);
  el.append(copy);
  if (navigator.share) {
    const b = document.createElement('button');
    b.textContent = 'Share';
    b.onclick = () => navigator.share({ text: s[item].text }).then(() => post('shared:' + item + ':sheet')).catch(() => {});
    el.append(b);
  }
  for (const [route, url] of Object.entries(s[item].routes)) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = labels[route] || route;
    if ((s.dimmed[item] || []).includes(route)) a.className = 'dim';
    a.onclick = () => post('shared:' + item + ':' + route);
    el.append(a);
  }
}
async function tick() {
  let s;
  try { s = await (await fetch(base + '/state')).json(); } catch (_e) { return; }
  for (const v of ['confirm', 'password', 'link', 'closed']) $(v).hidden = s.view !== v;
  if (s.view === 'confirm') {
    $('c-name').textContent = s.confirm.name;
    $('c-size').textContent = s.confirm.size;
    $('c-to').textContent = s.confirm.recipient || 'you share the link yourself';
    $('c-credits').textContent = String(s.confirm.credits);
  }
  // A secret is only in the page while its view is on screen.
  if (s.view !== 'password') $('p-value').textContent = '';
  if (s.view !== 'link') $('l-value').textContent = '';
  if (s.view === 'password') { $('p-value').textContent = s.password.value; shares($('p-share'), 'password', s); }
  if (s.view === 'link') {
    $('l-value').textContent = s.link.value;
    $('l-mailed').hidden = !s.link.emailedTo;
    $('l-mailed-to').textContent = s.link.emailedTo || '';
    shares($('l-share'), 'link', s);
  }
}
$('send').onclick = () => post('send');
$('cancel').onclick = () => post('cancel');
$('saved').onclick = () => post('saved');
$('done').onclick = () => post('done');
tick();
setInterval(tick, 1000);
})();`;

const BODY = `<h1>VitalSend</h1>
<div class="card" id="confirm" hidden><p>Send <strong id="c-name"></strong> (<span id="c-size"></span>) to <strong id="c-to"></strong>?</p>
<p>It costs <span id="c-credits"></span> credit(s).</p><div class="row"><button class="primary" id="send">Send</button><button id="cancel">Cancel</button></div></div>
<div class="card" id="password" hidden><p>The password for this file. The recipient needs it to open the file. Send it another way than the link.</p>
<code id="p-value"></code><div class="row" id="p-share"></div><div class="row"><button class="primary" id="saved">I have saved the password</button></div></div>
<div class="card" id="link" hidden><p id="l-mailed" hidden>The link was emailed to <strong id="l-mailed-to"></strong>.</p>
<p>The link. It can be downloaded once.</p><code id="l-value" style="font-size:.9rem;letter-spacing:0"></code><div class="row" id="l-share"></div>
<div class="row"><button class="primary" id="done">Done</button></div></div>
<div class="card" id="closed" hidden><p>You can close this tab.</p></div>`;

const sha256 = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VitalSend</title><style>${STYLE}</style><body>${BODY}<script>${SCRIPT}</script></body></html>`;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export class BrowserUnavailable extends Error {
  constructor() {
    super('No browser could be opened on this computer.');
    this.name = 'BrowserUnavailable';
  }
}

const COOKIE = 'vs_page';
const SECRET_VIEWS = new Set(['confirm', 'password']);

const routesFor = (item, value) => Object.fromEntries(SHARE_ROUTES.map((r) => [r, shareUrl(r, shareText(item, value))]));

// The path reaches the browser through the opener's argv, so a local process
// can learn it. Knowing it is not enough: the single page load sets a random
// cookie, and /state and /action answer only to that cookie.
export async function openDeliveryPage({ openBrowser, timeoutMs = 5 * 60 * 1000, linkTimeoutMs = 30 * 60 * 1000 }) {
  const path = `/${randomBytes(32).toString('base64url')}`;
  const pageSecret = randomBytes(32).toString('base64url');
  const used = { link: new Set(), password: new Set() };
  let view = 'idle';
  let data = {};
  let pageServed = false;
  let browserOpened = false;
  let pending = null; // { accepts: Set, resolve, timer }

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const host = origin.slice('http://'.length);

  const dimmed = () => ({
    password: [...used.link].filter((r) => r !== 'sheet'),
    link: [...used.password].filter((r) => r !== 'sheet'),
  });
  const snapshot = () => ({ view, ...data, dimmed: dimmed() });

  const settle = (result) => {
    if (!pending) return;
    const { resolve, timer } = pending;
    pending = null;
    clearTimeout(timer);
    resolve(result);
  };
  const openOnce = async () => {
    if (browserOpened) return;
    browserOpened = true;
    try {
      await openBrowser(`${origin}${path}`);
    } catch (_err) {
      throw new BrowserUnavailable();
    }
  };
  const show = async (nextView, nextData, accepts) => {
    settle('superseded');
    await openOnce();
    view = nextView;
    data = nextData;
    const wait = nextView === 'link' ? linkTimeoutMs : timeoutMs;
    return new Promise((resolve) => {
      pending = { accepts: new Set(accepts), resolve, timer: setTimeout(() => settle('timeout'), wait) };
    });
  };
  const hasCookie = (req) => (req.headers.cookie || '').split(';').some((c) => c.trim() === `${COOKIE}=${pageSecret}`);

  server.on('request', async (req, res) => {
    const url = new URL(req.url, origin);
    const empty = (status) => res.writeHead(status, { 'Cache-Control': 'no-store' }).end();
    if (req.headers.host !== host || !url.pathname.startsWith(path)) return empty(404);
    const rest = url.pathname.slice(path.length);
    if (rest === '' && req.method === 'GET') {
      if (pageServed) {
        // Something other than the user's tab loaded the page: stop before
        // anything is spent or shown.
        if (SECRET_VIEWS.has(view)) settle('cancel');
        return empty(404);
      }
      pageServed = true;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Set-Cookie': `${COOKIE}=${pageSecret}; HttpOnly; SameSite=Strict; Path=${path}`,
      });
      return res.end(HTML);
    }
    if (!hasCookie(req)) return empty(404);
    if (rest === '/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(snapshot()));
    }
    if (rest === '/action' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== origin) return empty(403);
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return empty(413);
      }
      let action = '';
      try { action = String(JSON.parse(body).action || ''); } catch (_err) { return empty(400); }
      const shared = /^shared:(link|password):(sheet|sms|whatsapp|telegram|email)$/.exec(action);
      if (shared) used[shared[1]].add(shared[2]);
      else if (pending?.accepts.has(action)) settle(action);
      return empty(204);
    }
    return empty(404);
  });

  return {
    open: openOnce,
    confirm({ recipient, name, sizeBytes, credits }) {
      return show('confirm', { confirm: { recipient: recipient || '', name, size: formatSize(sizeBytes), credits } }, ['send', 'cancel']);
    },
    showPassword(password) {
      return show('password', { password: { value: password, text: shareText('password', password), routes: routesFor('password', password) } }, ['saved']);
    },
    showLink({ link, emailedTo }) {
      if (emailedTo) used.link.add('email');
      return show('link', { link: { value: link, text: shareText('link', link), routes: routesFor('link', link), emailedTo: emailedTo || '' } }, ['done']);
    },
    close() {
      settle('closed');
      view = 'closed';
      data = {};
      setTimeout(() => { server.close(); server.closeAllConnections?.(); }, 3000).unref();
    },
  };
}
