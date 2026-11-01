// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// Where the package's VitalSend login lives: an API key from the environment
// (CI, scripts), or an OAuth refresh token in a file only the user can read.
// Access tokens stay in memory. Nothing here ever logs a secret.
import { mkdir, readFile, writeFile, rename, rm, chmod, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const FILE = 'mcp-credentials.json';
const EXPIRY_SKEW_MS = 30_000;
const LOCK = 'mcp-credentials.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export class LoginRequired extends Error {
  constructor() {
    super('Sign in to VitalSend to send files.');
    this.name = 'LoginRequired';
  }
}

export function defaultCredentialsDir(env = process.env, platform = process.platform) {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'vitalsend');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vitalsend');
}

function expiresAt(accessToken, expiresIn, now) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    if (payload.exp) return payload.exp * 1000;
  } catch (_err) {
    // fall through to expires_in
  }
  return now() + Number(expiresIn || 0) * 1000;
}

export function createCredentials({ dir = defaultCredentialsDir(), env = process.env, tokens, now = Date.now }) {
  const file = join(dir, FILE);
  let cached = null; // { accessToken, expiresAt }

  const load = async () => {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return typeof data?.refreshToken === 'string' && data.refreshToken ? data : null;
    } catch (_err) {
      return null;
    }
  };
  // Two clients can run the package at once. A refresh rotates the token, and
  // presenting a rotated-away token revokes the connection, so refreshes are
  // serialized across processes with a lock file.
  const withLock = async (fn) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, LOCK);
    const started = now();
    for (;;) {
      try {
        const handle = await open(lock, 'wx', 0o600);
        await handle.close();
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true });
        else if (now() - started > LOCK_WAIT_MS) throw err;
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  };
  const fresh = () => cached && cached.expiresAt - now() > EXPIRY_SKEW_MS;
  const remember = (t) => {
    cached = { accessToken: t.accessToken, expiresAt: expiresAt(t.accessToken, t.expiresIn, now) };
    return t.accessToken;
  };

  const self = {
    async mode() {
      if (env.VITALSEND_API_KEY) return 'api_key';
      return (await load()) ? 'oauth' : 'none';
    },
    // Written to a private temp file and renamed into place, so a reader
    // never sees half a file.
    async save({ refreshToken }) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const tmp = join(dir, `.${FILE}.${randomBytes(6).toString('hex')}`);
      await writeFile(tmp, JSON.stringify({ refreshToken }), { mode: 0o600 });
      await rename(tmp, file);
    },
    async clear() {
      cached = null;
      await rm(file, { force: true });
    },
    async accessToken() {
      if (fresh()) return cached.accessToken;
      if (env.VITALSEND_API_KEY) {
        return remember(await tokens.exchangeAPIKey(env.VITALSEND_API_KEY));
      }
      return withLock(async () => {
        if (fresh()) return cached.accessToken;
        const stored = await load();
        if (!stored) throw new LoginRequired();
        let next;
        try {
          next = await tokens.refresh(stored.refreshToken);
        } catch (err) {
          if (err?.code === 'invalid_grant') {
            await self.clear();
            throw new LoginRequired();
          }
          throw err;
        }
        await self.save({ refreshToken: next.refreshToken });
        return remember(next);
      });
    },
    // After a login: keep the refresh token, use the access token.
    async adopt(loginTokens) {
      await self.save({ refreshToken: loginTokens.refreshToken });
      return remember(loginTokens);
    },
  };
  return self;
}
