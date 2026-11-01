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
  // Secrets go in a dialog only on 2025-era connections: a 2026-era client
  // calls the tool again after answering, and the password must not change
  // between the dialog and the send.
  const canShowSecrets = canForm && !era2026;
  const ask = (key, request) => { throw new NeedInput(inputRequired({ inputRequests: { [key]: request } })); };

  return {
    async roots() {
      if (!caps.roots) return null;
      if (!era2026) return (await server.server.listRoots()).roots.map((r) => r.uri);
      if (answers.roots?.roots) return answers.roots.roots.map((r) => r.uri);
      return ask('roots', inputRequired.listRoots());
    },
    // login: { done, cancel } from startLogin. On 2025-era connections the
    // client may hold its dialog open until told the login is complete, so the
    // dialog is not awaited: completing the login closes it, declining it
    // cancels the login.
    async openLogin(url, login) {
      if (!canUrl) return openBrowser(url);
      if (!era2026) {
        const elicitationId = `login-${Date.now()}`;
        ctx.mcpReq.elicitInput({ mode: 'url', url, message: LOGIN_MESSAGE, elicitationId })
          .then((res) => { if (res?.action !== 'accept') login?.cancel(); }, () => login?.cancel());
        login?.done.then(() => server.server.createElicitationCompletionNotifier(elicitationId)(), () => {}).catch(() => {});
        return undefined;
      }
      if (answers.login) return undefined;
      return ask('login', inputRequired.elicitUrl({ url, message: LOGIN_MESSAGE }));
    },
    canShowSecrets,
    async confirm({ recipient, name, sizeBytes, size, credits, password }) {
      if (!canForm) return 'unavailable';
      const cost = `${credits} credit${credits === 1 ? '' : 's'}`;
      let message = `Send ${name} (${size || `${sizeBytes} bytes`}) ${recipient ? `to ${recipient}` : 'and share the link yourself'} for ${cost}?`;
      if (password && canShowSecrets) {
        const to = recipient || 'the recipient';
        message += `\n\n    Password:   ${password}\n\nCopy the password now and send it to ${to} yourself, by text message for example. ` +
          (recipient ? 'Not by email: the link arrives by email, and the two must travel separately.' : 'Not together with the link.') +
          ' The password is shown only here.';
      }
      const request = { mode: 'form', message, requestedSchema: { type: 'object', properties: {} } };
      if (!era2026) {
        const res = await ctx.mcpReq.elicitInput(request);
        return res?.action === 'accept' ? 'send' : 'cancel';
      }
      if (answers.confirm) return answers.confirm.action === 'accept' ? 'send' : 'cancel';
      return ask('confirm', inputRequired.elicit({ message, requestedSchema: request.requestedSchema }));
    },
    async showLink(link, { password = false } = {}) {
      if (!canShowSecrets) return 'unavailable';
      const res = await ctx.mcpReq.elicitInput({
        mode: 'form',
        requestedSchema: { type: 'object', properties: {} },
        message: `Uploaded. Copy the link and send it to the recipient; it can be downloaded once:\n\n    ${link}` +
          (password ? '\n\nSend the password another way than the link.' : ''),
      });
      return res?.action || 'cancel';
    },
  };
}
