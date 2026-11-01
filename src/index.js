// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// Entry point: the VitalSend MCP server over stdio. stdout carries the
// protocol, so nothing here prints.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './server.js';
import { createTokenClient, createSendSession } from './api.js';
import { createCredentials } from './credentials.js';
import { startLogin } from './login.js';
import { openDeliveryPage } from './delivery-page.js';
import { openBrowser } from './browser.js';

const baseUrl = (process.env.VITALSEND_BASE_URL || 'https://vitalsend.eu').replace(/\/+$/, '');
const tokens = createTokenClient({ baseUrl });
const credentials = createCredentials({ tokens });

// One login at a time: on 2026-era connections the tool call is retried after
// the login page, and the retry must wait on the same listener.
let activeLogin = null;
async function login({ connectionName }) {
  if (activeLogin && !activeLogin.settled) return activeLogin;
  const started = await startLogin({ baseUrl, tokens, connectionName });
  activeLogin = started;
  started.done.then(() => {}, () => {}).finally(() => { started.settled = true; });
  return started;
}

const server = buildServer({
  openBrowser,
  sendFileDeps: (srv) => ({
    credentials,
    newSession: (accessToken) => createSendSession({ baseUrl, accessToken }),
    openPage: () => openDeliveryPage({ openBrowser }),
    startLogin: login,
    clientName: srv.server.getClientVersion?.()?.name || 'AI app',
    cwd: process.cwd(),
    envRoot: process.env.VITALSEND_ROOT || '',
  }),
});
await server.connect(new StdioServerTransport());
