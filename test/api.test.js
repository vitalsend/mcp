// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, openAsBlob } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSendSession, createTokenClient, ApiError } from '../src/api.js';

const ACCESS = 'access-token-xyz';
const SECRET_IN_BODY = 'vsr_server_secret_must_not_leak';

// A fake VitalSend that checks every call the way the backend does and
// records what it was sent.
function fakeVitalSend() {
  const seen = [];
  let failNext = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const call = { method: req.method, url: req.url, headers: req.headers, body };
    seen.push(call);
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (failNext && req.url.endsWith(failNext.path)) {
      const f = failNext; failNext = null;
      return json(f.status, f.body);
    }
    const cookie = req.headers.cookie || '';
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const path = req.url.split('?')[0];
    if (path === '/api/v1/oauth/token') {
      const form = new URLSearchParams(body.toString());
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'vsr_dead') {
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 900, ...(form.get('grant_type') === 'refresh_token' ? { refresh_token: 'vsr_next' } : {}) });
    }
    if (!cookie.includes(`vitalsend_jwt=${ACCESS}`)) return json(401, { message: 'unauthorized' });
    if (path === '/api/v1/managedsend/init') {
      return json(200, { step_token: 's1' }, { 'Set-Cookie': 'vitalsend_flow=f1; Path=/; HttpOnly; SameSite=Lax' });
    }
    if (!cookie.includes('vitalsend_flow=f1')) return json(401, { message: 'no flow' });
    // Step 1 covers quote and reserve (FlowStepMiddleware(1)), so either step-1 token works there.
    const expect = { '/quote': ['s1', 's1q'], '/reserve': ['s1', 's1q'], '/prepare/start': ['s3'], '/prepare/part': ['s3'], '/prepare/complete': ['s3'], '/link': ['s5'], '/send-email': ['s5l'] };
    const short = path.replace('/api/v1/managedsend', '');
    if (expect[short] && !expect[short].includes(bearer)) return json(401, { message: `bad step token for ${short}` });
    switch (short) {
      case '/quote': return json(200, { credits_needed: 1, step_token: 's1q' });
      case '/reserve': return json(200, { file_id: 'file-1', credits_needed: 1, expires_at: '2026-11-08T10:00:00Z', step_token: 's3' });
      case '/prepare/start': return json(200, { upload_id: 'file-1' });
      case '/prepare/part': res.writeHead(204); return res.end();
      case '/prepare/complete': return json(200, { file_id: 'file-1', step_token: 's5' });
      case '/link': return json(200, { file_id: 'file-1', link: 'https://vitalsend.eu/download/?file=VS10abc', expires_at: '2026-11-08T10:00:00Z', step_token: 's5l' });
      case '/send-email': return json(200, { step_token: 's5e' });
      default: return json(404, {});
    }
  });
  return {
    seen,
    failOnce(path, status, body) { failNext = { path, status, body }; },
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    stop: () => new Promise((r) => server.close(r)),
  };
}

async function tempFile(size) {
  const dir = await promisify(mkdtemp)(join(tmpdir(), 'vs-api-'));
  const path = join(dir, 'report.pdf');
  await promisify(writeFile)(path, randomBytes(size));
  return openAsBlob(path);
}

let fake;
let baseUrl;
beforeEach(async () => { fake = fakeVitalSend(); baseUrl = await fake.start(); });
afterEach(async () => { await fake.stop(); });

describe('send session', () => {
  it('runs the browser flow: flow cookie, step tokens threaded, access token as cookie', async () => {
    const s = createSendSession({ baseUrl, accessToken: ACCESS });
    await s.init();
    const quote = await s.quote({ sizeBytes: 1000, password: true });
    expect(quote.creditsNeeded).toBe(1);
    const reserved = await s.reserve({ name: 'report.pdf', type: 'application/pdf', sizeBytes: 1000, passwordVerifier: 'verifier-abc' });
    expect(reserved.expiresAt).toBe('2026-11-08T10:00:00Z');
    await s.upload({ blob: await tempFile(150_000), linkKey: new Uint8Array(32).fill(3), password: 'ABCDEFGH23', chunkSize: 64 * 1024 });
    await s.complete({ name: 'report.pdf', type: 'application/pdf', sizeBytes: 1000 });
    const base = await s.link();
    expect(base).toBe('https://vitalsend.eu/download/?file=VS10abc');
    await s.sendEmail({ recipient: 'kalle@example.com', link: base + '#k=key' });

    for (const call of fake.seen) {
      expect(call.headers.authorization || '').not.toContain(ACCESS);
    }
    const reserve = fake.seen.find((c) => c.url.endsWith('/reserve'));
    expect(JSON.parse(reserve.body.toString()).extra_password).toBe('verifier-abc');
    const parts = fake.seen.filter((c) => c.url.endsWith('/prepare/part'));
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0].headers['x-vitalsend-upload-id']).toBe('file-1');
    expect(parts[1].headers['x-vitalsend-chunk-index']).toBe('0');
    expect(parts[1].headers['x-vitalsend-upload-offset']).toBe(String(parts[0].body.length));
  });

  it('never sends the password itself', async () => {
    const password = 'QWERTYUP23';
    const s = createSendSession({ baseUrl, accessToken: ACCESS });
    await s.init();
    await s.reserve({ name: 'a.txt', type: 'text/plain', sizeBytes: 10, passwordVerifier: 'v' });
    await s.upload({ blob: await tempFile(10), linkKey: new Uint8Array(32).fill(1), password, chunkSize: 1024 });
    for (const call of fake.seen) {
      expect(call.body.toString('latin1')).not.toContain(password);
      expect(JSON.stringify(call.headers)).not.toContain(password);
    }
  });

  it('maps a credit shortfall to credits_insufficient', async () => {
    fake.failOnce('/reserve', 403, { code: 'credits_insufficient', message: 'x' });
    const s = createSendSession({ baseUrl, accessToken: ACCESS });
    await s.init();
    await expect(s.reserve({ name: 'a', type: '', sizeBytes: 1, passwordVerifier: '' })).rejects.toMatchObject({ code: 'credits_insufficient' });
  });

  it('maps a disallowed recipient to recipient_not_allowed', async () => {
    fake.failOnce('/send-email', 403, { code: 'recipient_not_allowed' });
    const s = createSendSession({ baseUrl, accessToken: ACCESS });
    await s.init();
    await s.reserve({ name: 'a', type: '', sizeBytes: 1, passwordVerifier: '' });
    await s.complete({ name: 'a', type: '', sizeBytes: 1 });
    await s.link();
    await expect(s.sendEmail({ recipient: 'x@y.se', link: 'l' })).rejects.toMatchObject({ code: 'recipient_not_allowed' });
  });

  it('errors carry no URL, token or response body', async () => {
    fake.failOnce('/quote', 500, { message: SECRET_IN_BODY });
    const s = createSendSession({ baseUrl, accessToken: ACCESS });
    await s.init();
    const err = await s.quote({ sizeBytes: 1, password: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('server');
    const text = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
    expect(text).not.toContain(SECRET_IN_BODY);
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(baseUrl);
  });

  it('a dead network is a network error', async () => {
    const s = createSendSession({ baseUrl: 'http://127.0.0.1:1', accessToken: ACCESS });
    await expect(s.init()).rejects.toMatchObject({ code: 'network' });
  });
});

describe('token client', () => {
  it('uses the part-1 grant types, form-encoded', async () => {
    const t = createTokenClient({ baseUrl });
    expect((await t.exchangeAPIKey('vsk_k')).accessToken).toBe(ACCESS);
    const refreshed = await t.refresh('vsr_old');
    expect(refreshed.refreshToken).toBe('vsr_next');
    await t.exchangeCode({ code: 'vsc_c', verifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:5/cb' });
    const grants = fake.seen.map((c) => new URLSearchParams(c.body.toString()).get('grant_type'));
    expect(grants).toEqual(['urn:vitalsend:params:oauth:grant-type:api-key', 'refresh_token', 'authorization_code']);
    expect(fake.seen.every((c) => c.headers['content-type'] === 'application/x-www-form-urlencoded')).toBe(true);
    expect(new URLSearchParams(fake.seen[2].body.toString()).get('client_id')).toBe('vitalsend-mcp');
  });

  it('maps invalid_grant', async () => {
    const t = createTokenClient({ baseUrl });
    await expect(t.refresh('vsr_dead')).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});

describe('quote', () => {
  it('sends the recipient so the server can refuse it before anything is spent', async () => {
    const s = createSendSession({ baseUrl, accessToken: ACCESS });
    await s.init();
    await s.quote({ sizeBytes: 10, password: false, recipient: 'kalle@example.com' });
    const quote = fake.seen.find((c) => c.url.endsWith('/quote'));
    expect(JSON.parse(quote.body.toString()).recipient_email).toBe('kalle@example.com');
  });
});

describe('redirects', () => {
  it('never follows a redirect, so cookies and step tokens cannot leave for another origin', async () => {
    let elsewhereHit = false;
    const elsewhere = createServer((req, res) => { elsewhereHit = true; res.end('{}'); });
    await new Promise((r) => elsewhere.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${elsewhere.address().port}/steal`;
    const redirecting = createServer((req, res) => { res.writeHead(302, { Location: target }); res.end(); });
    await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
    const s = createSendSession({ baseUrl: `http://127.0.0.1:${redirecting.address().port}`, accessToken: ACCESS });
    await expect(s.init()).rejects.toBeInstanceOf(ApiError);
    expect(elsewhereHit).toBe(false);
    await new Promise((r) => elsewhere.close(r));
    await new Promise((r) => redirecting.close(r));
  });
});
