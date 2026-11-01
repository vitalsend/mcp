// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// Asking the user, across both protocol eras. On 2025-era connections the
// server awaits elicitInput/listRoots; on 2026-07-28 it returns
// inputRequired(...) and the client calls the tool again with the answers, so
// each ask either returns its answer or throws NeedInput for the handler to
// return. Without elicitation, confirmation falls back to the local page and
// the login to the system browser.
import { inputRequired } from '@modelcontextprotocol/server';

export class NeedInput extends Error {
  constructor(value) {
    super('input required');
    this.inputRequired = true;
    this.value = value;
  }
}

const LOGIN_MESSAGE = 'Sign in to VitalSend to send this file. The page opens on vitalsend.eu.';

export function createIo({ server, ctx, openBrowser }) {
  const era2026 = !!ctx?.mcpReq?.envelope;
  const caps = server.server.getClientCapabilities?.() || {};
  const answers = ctx?.mcpReq?.inputResponses || {};
  const elicitation = caps.elicitation;
  const canForm = !!elicitation && (Object.keys(elicitation).length === 0 || !!elicitation.form);
  const canUrl = !!elicitation?.url;
  const ask = (key, request) => { throw new NeedInput(inputRequired({ inputRequests: { [key]: request } })); };

  return {
    async roots() {
      if (!caps.roots) return null;
      if (!era2026) return (await server.server.listRoots()).roots.map((r) => r.uri);
      if (answers.roots?.roots) return answers.roots.roots.map((r) => r.uri);
      return ask('roots', inputRequired.listRoots());
    },
    async openLogin(url) {
      if (!canUrl) return openBrowser(url);
      if (!era2026) {
        await ctx.mcpReq.elicitInput({ mode: 'url', url, message: LOGIN_MESSAGE, elicitationId: `login-${Date.now()}` });
        return undefined;
      }
      if (answers.login) return undefined;
      return ask('login', inputRequired.elicitUrl({ url, message: LOGIN_MESSAGE }));
    },
    async confirm({ recipient, name, sizeBytes, credits }) {
      if (!canForm) return 'unavailable';
      const message = `Send ${name} (${sizeBytes} bytes) ${recipient ? `to ${recipient}` : 'and share the link yourself'}? It costs ${credits} credit${credits === 1 ? '' : 's'}.`;
      const request = { mode: 'form', message, requestedSchema: { type: 'object', properties: {} } };
      if (!era2026) {
        const res = await ctx.mcpReq.elicitInput(request);
        return res?.action === 'accept' ? 'send' : 'cancel';
      }
      if (answers.confirm) return answers.confirm.action === 'accept' ? 'send' : 'cancel';
      return ask('confirm', inputRequired.elicit({ message, requestedSchema: request.requestedSchema }));
    },
  };
}
