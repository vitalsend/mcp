// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { startLogin, LoginDeclined, LoginTimeout } from '../src/login.js';

function parse(url) {
  const u = new URL(url);
  return { u, q: Object.fromEntries(u.searchParams) };
}

describe('OAuth login', () => {
  it('builds a PKCE S256 consent URL with a loopback redirect', async () => {
    const tokens = { exchangeCode: vi.fn() };
    const login = await startLogin({ baseUrl: 'https://vitalsend.eu', tokens, connectionName: 'Cursor', timeoutMs: 2000 });
    const { u, q } = parse(login.url);
    expect(u.origin + u.pathname).toBe('https://vitalsend.eu/oauth/authorize/');
    expect(q.client_id).toBe('vitalsend-mcp');
    expect(q.code_challenge_method).toBe('S256');
    expect(q.connection_name).toBe('Cursor');
    expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.state.length).toBeGreaterThanOrEqual(32);
    login.cancel();
    await expect(login.done).rejects.toBeTruthy();
  });

  it('exchanges the code with the matching verifier and closes', async () => {
    let seen;
    const tokens = { exchangeCode: vi.fn(async (args) => { seen = args; return { accessToken: 'a', refreshToken: 'vsr_r' }; }) };
    const login = await startLogin({ baseUrl: 'https://vitalsend.eu', tokens, connectionName: 'X', timeoutMs: 5000 });
    const { q } = parse(login.url);
    const res = await fetch(`${q.redirect_uri}?code=vsc_c&state=${q.state}`);
    expect(res.status).toBe(200);
    await expect(login.done).resolves.toMatchObject({ refreshToken: 'vsr_r' });
    expect(seen.code).toBe('vsc_c');
    expect(seen.redirectUri).toBe(q.redirect_uri);
    const challenge = createHash('sha256').update(seen.verifier).digest('base64url');
    expect(challenge).toBe(q.code_challenge);
    await expect(fetch(`${q.redirect_uri}?code=vsc_c&state=${q.state}`)).rejects.toBeTruthy(); // listener closed
  });

  it('ignores a wrong state and other paths, and keeps waiting', async () => {
    const tokens = { exchangeCode: vi.fn(async () => ({ refreshToken: 'vsr_r' })) };
    const login = await startLogin({ baseUrl: 'https://vitalsend.eu', tokens, connectionName: 'X', timeoutMs: 5000 });
    const { q } = parse(login.url);
    const base = q.redirect_uri.replace('/callback', '');
    expect((await fetch(`${q.redirect_uri}?code=vsc_evil&state=wrong`)).status).toBe(400);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
    await fetch(`${q.redirect_uri}?code=vsc_c&state=${q.state}`);
    await expect(login.done).resolves.toBeTruthy();
  });

  it('a denied consent is a declined login', async () => {
    const login = await startLogin({ baseUrl: 'https://vitalsend.eu', tokens: { exchangeCode: vi.fn() }, connectionName: 'X', timeoutMs: 5000 });
    const { q } = parse(login.url);
    await fetch(`${q.redirect_uri}?error=access_denied&state=${q.state}`);
    await expect(login.done).rejects.toBeInstanceOf(LoginDeclined);
  });

  it('times out and closes the listener', async () => {
    const login = await startLogin({ baseUrl: 'https://vitalsend.eu', tokens: { exchangeCode: vi.fn() }, connectionName: 'X', timeoutMs: 150 });
    const { q } = parse(login.url);
    await expect(login.done).rejects.toBeInstanceOf(LoginTimeout);
    await expect(fetch(q.redirect_uri)).rejects.toBeTruthy();
  });
});
