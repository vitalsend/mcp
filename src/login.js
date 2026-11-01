// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// OAuth login for a native app (RFC 8252): authorization code with PKCE S256,
// redirect to a listener on 127.0.0.1 that takes one callback and closes.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { CLIENT_ID } from './api.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class LoginDeclined extends Error {
  constructor() { super('The VitalSend login was declined.'); this.name = 'LoginDeclined'; }
}

export class LoginTimeout extends Error {
  constructor() { super('The VitalSend login was not completed in time.'); this.name = 'LoginTimeout'; }
}

const PAGE = (text) => `<!doctype html><meta charset="utf-8"><title>VitalSend</title><p style="font-family:system-ui;margin:3rem">${text}</p>`;

export async function startLogin({ baseUrl, tokens, connectionName, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');

  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  // The login can end before anyone awaits it (a denied consent while the tool
  // waits elsewhere); an unhandled rejection would kill the server process.
  done.catch(() => {});
  let finished = false;
  const server = createServer();
  const finish = (fn) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    fn();
  };

  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (finished || url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('This sign-in link is not valid.'));
      return;
    }
    if (url.searchParams.get('error')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(PAGE('Not connected. You can close this tab.'));
      finish(() => settle.reject(new LoginDeclined()));
      return;
    }
    try {
      const result = await tokens.exchangeCode({ code: url.searchParams.get('code') || '', verifier, redirectUri });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(PAGE('Connected. You can go back to your app.'));
      finish(() => settle.resolve(result));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(PAGE('Sign-in failed. Try again from your app.'));
      finish(() => settle.reject(err));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => finish(() => settle.reject(new LoginTimeout())), timeoutMs);

  const url = new URL('/oauth/authorize/', baseUrl);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    connection_name: connectionName || 'AI app',
  }).toString();

  return {
    url: url.toString(),
    done,
    cancel: () => finish(() => settle.reject(new LoginDeclined())),
  };
}
