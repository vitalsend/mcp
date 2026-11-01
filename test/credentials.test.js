// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentials, LoginRequired } from '../src/credentials.js';
import { ApiError } from '../src/api.js';

const fakeJwt = (expSeconds) => `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function tokensFake() {
  return {
    exchangeAPIKey: vi.fn(async () => ({ accessToken: fakeJwt(inAnHour()), expiresIn: 900, refreshToken: '' })),
    refresh: vi.fn(async (rt) => {
      if (rt === 'vsr_dead') throw new ApiError('invalid_grant', 400);
      return { accessToken: fakeJwt(inAnHour()), expiresIn: 900, refreshToken: `${rt}_next` };
    }),
  };
}

async function dir() {
  return join(await mkdtemp(join(tmpdir(), 'vs-cred-')), 'vitalsend');
}

describe('credentials', () => {
  it('uses VITALSEND_API_KEY when set', async () => {
    const tokens = tokensFake();
    const c = createCredentials({ dir: await dir(), env: { VITALSEND_API_KEY: 'vsk_k' }, tokens });
    expect(await c.mode()).toBe('api_key');
    expect(await c.accessToken()).toMatch(/^h\./);
    await c.accessToken();
    expect(tokens.exchangeAPIKey).toHaveBeenCalledTimes(1); // cached until near expiry
  });

  it('asks for login when nothing is stored', async () => {
    const c = createCredentials({ dir: await dir(), env: {}, tokens: tokensFake() });
    expect(await c.mode()).toBe('none');
    await expect(c.accessToken()).rejects.toBeInstanceOf(LoginRequired);
  });

  it('stores the refresh token privately and rotates it before returning', async () => {
    const d = await dir();
    const tokens = tokensFake();
    const c = createCredentials({ dir: d, env: {}, tokens });
    await c.save({ refreshToken: 'vsr_one' });
    expect((await stat(d)).mode & 0o777).toBe(0o700);
    const file = join(d, 'mcp-credentials.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await c.mode()).toBe('oauth');
    await c.accessToken();
    expect(tokens.refresh).toHaveBeenCalledWith('vsr_one');
    expect(JSON.parse(await readFile(file, 'utf8')).refreshToken).toBe('vsr_one_next');
  });

  it('a dead refresh token clears the store and asks for login', async () => {
    const d = await dir();
    const c = createCredentials({ dir: d, env: {}, tokens: tokensFake() });
    await c.save({ refreshToken: 'vsr_dead' });
    await expect(c.accessToken()).rejects.toBeInstanceOf(LoginRequired);
    expect(await c.mode()).toBe('none');
  });

  it('concurrent saves never leave a broken file', async () => {
    const d = await dir();
    const c = createCredentials({ dir: d, env: {}, tokens: tokensFake() });
    await Promise.all(Array.from({ length: 25 }, (_, i) => c.save({ refreshToken: `vsr_${i}` })));
    const parsed = JSON.parse(await readFile(join(d, 'mcp-credentials.json'), 'utf8'));
    expect(parsed.refreshToken).toMatch(/^vsr_\d+$/);
  });

  it('treats a corrupt file as no login', async () => {
    const d = await dir();
    const c = createCredentials({ dir: d, env: {}, tokens: tokensFake() });
    await c.save({ refreshToken: 'vsr_x' });
    await writeFile(join(d, 'mcp-credentials.json'), '{not json');
    expect(await c.mode()).toBe('none');
  });

  it('never logs a token', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => vi.spyOn(console, m));
    const c = createCredentials({ dir: await dir(), env: {}, tokens: tokensFake() });
    await c.save({ refreshToken: 'vsr_secret' });
    await c.accessToken();
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('vsr_');
      spy.mockRestore();
    }
  });

  it('two processes refreshing at once do not lose the newest token', async () => {
    const d = await dir();
    // The server: one current token; presenting an older one revokes.
    let current = 'vsr_0';
    let n = 0;
    let revoked = false;
    const server = {
      refresh: vi.fn(async (rt) => {
        await new Promise((r) => setTimeout(r, 30));
        if (rt !== current) { revoked = true; throw new ApiError('invalid_grant', 400); }
        current = `vsr_${++n}`;
        return { accessToken: fakeJwt(inAnHour()), expiresIn: 900, refreshToken: current };
      }),
    };
    const a = createCredentials({ dir: d, env: {}, tokens: server });
    const b = createCredentials({ dir: d, env: {}, tokens: server });
    await a.save({ refreshToken: 'vsr_0' });
    await Promise.all([a.accessToken(), b.accessToken()]);
    expect(revoked).toBe(false);
    expect(JSON.parse(await readFile(join(d, 'mcp-credentials.json'), 'utf8')).refreshToken).toBe(current);
  });
});
