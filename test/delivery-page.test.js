// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { JSDOM } from 'jsdom';
import { openDeliveryPage } from '../src/delivery-page.js';

const LINK = 'https://vitalsend.eu/download/?file=VS11abc#k=secretkey&p=1';
const PASSWORD = 'QWERTYUP23';

let page;
let opened;
afterEach(() => page?.close());

async function open(timeoutMs = 5000) {
  opened = [];
  page = await openDeliveryPage({ openBrowser: async (url) => { opened.push(url); }, timeoutMs });
  return page;
}

function raw(url, { method = 'GET', host, headers = {}, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Host: host || u.host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let cookie = '';
async function load() {
  const res = await raw(opened[0]);
  cookie = (res.headers['set-cookie'] || [])[0]?.split(';')[0] || '';
  return res;
}
const act = (action) => raw(`${opened[0]}/action`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: new URL(opened[0]).origin, Cookie: cookie },
  body: JSON.stringify({ action }),
});
const state = async () => JSON.parse((await raw(`${opened[0]}/state`, { headers: { Cookie: cookie } })).body);
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('delivery page', () => {
  it('opens the browser on a random 127.0.0.1 path and serves the page once', async () => {
    await open();
    const pending = page.showPassword(PASSWORD);
    await new Promise((r) => setTimeout(r, 20));
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    const first = await load();
    expect(first.status).toBe(200);
    await act('saved');
    await expect(pending).resolves.toBe('saved');
  });

  it('answers nothing on other paths or with a foreign Host', async () => {
    await open();
    page.showPassword(PASSWORD);
    await new Promise((r) => setTimeout(r, 20));
    const base = new URL(opened[0]);
    for (const res of [
      await raw(`${base.origin}/`),
      await raw(`${base.origin}/state`),
      await raw(`${opened[0]}/state`, { host: 'evil.example' }),
      await raw(opened[0], { host: `localhost:${base.port}` }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toBe('');
    }
  });

  it('refuses actions from another origin', async () => {
    await open();
    page.showPassword(PASSWORD);
    await new Promise((r) => setTimeout(r, 20));
    await load();
    const res = await raw(`${opened[0]}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie }, body: '{"action":"saved"}',
    });
    expect(res.status).toBe(403);
  });

  it('sends a strict CSP and no external origin', async () => {
    await open();
    page.showPassword(PASSWORD);
    await new Promise((r) => setTimeout(r, 20));
    const res = await raw(opened[0]);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the password share text never carries the link', async () => {
    await open();
    page.showPassword(PASSWORD);
    await settle();
    await load();
    const s = await state();
    expect(s.view).toBe('password');
    expect(s.password.text).toBe(`The password for the file I sent you: ${PASSWORD}`);
    for (const url of Object.values(s.password.routes)) {
      expect(decodeURIComponent(url)).not.toContain('vitalsend.eu');
    }
  });

  it('times out when the password is never confirmed', async () => {
    await open(100);
    await expect(page.showPassword(PASSWORD)).resolves.toBe('timeout');
  });

  it('shows the link after the password, steering an emailed link away from the password email route', async () => {
    await open();
    const saved = page.showPassword(PASSWORD);
    await settle();
    await load();
    await act('saved');
    await saved;
    const done = page.showLink({ link: LINK, emailedTo: 'kalle@example.com' });
    const s = await state();
    expect(s.view).toBe('link');
    expect(s.link.text).toBe(`A file for you. It can be downloaded once: ${LINK}`);
    expect(s.link.emailedTo).toBe('kalle@example.com');
    expect(s.dimmed.password).toContain('email');
    expect(opened).toHaveLength(1); // same tab, no second window
    await act('done');
    await expect(done).resolves.toBe('done');
  });

  it('confirms or cancels a send', async () => {
    await open();
    const decision = page.confirm({ recipient: '', name: 'a.env', sizeBytes: 120, credits: 1 });
    await settle();
    await load();
    const s = await state();
    expect(s.view).toBe('confirm');
    expect(s.confirm.name).toBe('a.env');
    await act('cancel');
    await expect(decision).resolves.toBe('cancel');
  });

  it('knowing the address is not enough: state and actions need the cookie from the single page load', async () => {
    await open();
    const pending = page.showPassword(PASSWORD);
    await settle();
    await load();
    const noCookie = await raw(`${opened[0]}/state`);
    expect(noCookie.status).toBe(404);
    expect(noCookie.body).not.toContain(PASSWORD);
    const forged = await raw(`${opened[0]}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'vs_page=guess' }, body: '{"action":"saved"}' });
    expect(forged.status).toBe(404);
    await act('saved');
    await expect(pending).resolves.toBe('saved');
  });

  it('a second load of the page while a secret is on screen cancels the send', async () => {
    await open();
    const pending = page.showPassword(PASSWORD);
    await settle();
    await load();
    const second = await raw(opened[0]);
    expect(second.status).toBe(404);
    await expect(pending).resolves.toBe('cancel');
  });

  it('the link view waits longer than the other views', async () => {
    opened = [];
    page = await openDeliveryPage({ openBrowser: async (url) => { opened.push(url); }, timeoutMs: 50, linkTimeoutMs: 5000 });
    let result = 'pending';
    page.showLink({ link: LINK, emailedTo: '' }).then((r) => { result = r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(result).toBe('pending');
  });

  it('opens the browser up front and reports a failure to do so', async () => {
    const p = await openDeliveryPage({ openBrowser: async () => { throw new Error('spawn xdg-open ENOENT'); }, timeoutMs: 1000 });
    await expect(p.open()).rejects.toMatchObject({ name: 'BrowserUnavailable' });
    p.close();
  });

  it('keeps the share buttons clickable across polls, and Copy copies and says so', async () => {
    await open();
    const shown = page.showPassword(PASSWORD);
    await settle();
    const res = await load();
    const copied = [];
    const dom = new JSDOM(res.body, {
      url: opened[0],
      runScripts: 'dangerously',
      beforeParse(window) {
        window.fetch = async (path, init = {}) => {
          const r = await raw(new URL(path, opened[0]).href, { method: init.method, headers: { ...(init.headers || {}), Cookie: cookie, Origin: new URL(opened[0]).origin }, body: init.body });
          return { json: async () => JSON.parse(r.body) };
        };
        Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } } });
      },
    });
    const copyButton = () => [...dom.window.document.querySelectorAll('#p-share button')].find((b) => b.textContent.includes('Copy') || b.textContent.includes('Done'));
    await new Promise((r) => setTimeout(r, 300));
    const first = copyButton();
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2200));
    expect(copyButton()).toBe(first);
    first.click();
    await settle();
    expect(copied).toEqual([PASSWORD]);
    expect(first.textContent).toContain('Done');
    dom.window.close();
    await act('saved');
    expect(await shown).toBe('saved');
  });
});
