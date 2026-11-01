// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// The send_file flow. What goes back to the model is built from a fixed
// template: never the link, its key, the password, a token, the file id or
// the local page's address, and never an error's own message.
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encodeLinkKey, buildShareLink, derivePasswordVerifier, generatePassword } from './crypto.js';
import { resolveAllowedFile, PathNotAllowed, RootRequired } from './paths.js';
import { ApiError } from './api.js';
import { LoginRequired } from './credentials.js';
import { LoginDeclined, LoginTimeout } from './login.js';
import { BrowserUnavailable } from './delivery-page.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (text) => ({ isError: true, text: `Not sent. ${text}` });

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatExpiry(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function explain(err) {
  if (err instanceof PathNotAllowed || err instanceof RootRequired) return fail(err.message);
  if (err instanceof BrowserUnavailable) return fail('No browser could be opened on this computer, so nothing was sent. Use an API key with recipient_email instead.');
  if (err instanceof LoginDeclined || err instanceof LoginTimeout) return fail('The VitalSend login was not completed.');
  if (err instanceof LoginRequired) return fail('Sign in to VitalSend first.');
  if (err instanceof ApiError) {
    if (err.code === 'credits_insufficient') return fail('Not enough credits. Top up at https://vitalsend.eu/me/.');
    return fail(err.message);
  }
  return fail('Something went wrong.');
}

export async function sendFile(input, deps) {
  const { credentials, newSession, openPage, startLogin, io, clientName, cwd } = deps;
  let page = null;
  let pageHandedOff = false;
  const getPage = async () => (page ||= await openPage());
  try {
    const mode = await credentials.mode();
    const recipient = String(input.recipient_email || '').trim();
    const withPassword = input.password ?? (mode !== 'api_key');
    if (mode === 'api_key' && withPassword) return fail('An API key cannot send with a password; sign in through the browser instead, or set password to false.');
    if (mode === 'api_key' && !recipient) return fail('With an API key the link is emailed, so recipient_email is required.');
    if (recipient && !EMAIL.test(recipient)) return fail('recipient_email is not a valid email address.');

    const path = await resolveAllowedFile(input.path, { roots: await io.roots(), cwd, envRoot: deps.envRoot || '' });
    const blob = await openAsBlob(path);
    const name = basename(path);
    const sizeBytes = blob.size;

    let accessToken;
    try {
      accessToken = await credentials.accessToken();
    } catch (err) {
      if (!(err instanceof LoginRequired)) throw err;
      const login = await startLogin({ connectionName: clientName });
      await io.openLogin(login.url, login);
      accessToken = await credentials.adopt(await login.done);
    }

    const session = newSession(accessToken);
    await session.init();
    const { creditsNeeded } = await session.quote({ sizeBytes, password: withPassword, recipient });

    const password = withPassword ? generatePassword() : null;
    // A client that can show secrets in its own dialogs gets the password in
    // the confirmation and no browser page; others get the local page.
    const inDialogs = mode !== 'api_key' && !!io.canShowSecrets;
    if (mode !== 'api_key') {
      const details = { recipient, name, sizeBytes, size: formatSize(sizeBytes), credits: creditsNeeded, password: inDialogs ? password : null };
      let decision = await io.confirm(details);
      if (decision === 'unavailable') decision = await (await getPage()).confirm(details);
      if (decision !== 'send') return fail('The send was cancelled.');
    }

    if (mode !== 'api_key' && !inDialogs) {
      // The page is where the password and the link reach the user, so its
      // browser must open before anything is reserved or spent.
      await (await getPage()).open();
      if (password) {
        const shown = await (await getPage()).showPassword(password);
        if (shown !== 'saved') return fail('The password was not confirmed in the browser, so nothing was sent and no credits were used.');
      }
    }

    const linkKey = new Uint8Array(randomBytes(32));
    const reserved = await session.reserve({
      name,
      type: blob.type || '',
      sizeBytes,
      passwordVerifier: password ? await derivePasswordVerifier(linkKey, password) : '',
    });
    await session.upload({ blob, linkKey, password });
    await session.complete({ name, type: blob.type || '', sizeBytes });
    const link = buildShareLink(await session.link(), encodeLinkKey(linkKey), !!password);
    // The upload is done and the credit spent: from here a failed email must
    // not lose the link. With a browser it goes to the user's page instead.
    let emailed = false;
    if (recipient) {
      try {
        await session.sendEmail({ recipient, link });
        emailed = true;
      } catch (err) {
        if (mode === 'api_key') {
          return fail(`The file was uploaded and ${creditsNeeded} credit${creditsNeeded === 1 ? ' was' : 's were'} used, but VitalSend could not email the link, and it cannot be shown here. ${explain(err).text.replace(/^Not sent\. /, '')}`);
        }
      }
    }

    let linkShown = emailed || mode === 'api_key';
    if (!linkShown && inDialogs) linkShown = (await io.showLink(link, { password: !!password }).catch(() => 'cancel')) === 'accept';
    if (mode !== 'api_key' && (!inDialogs || !linkShown)) {
      const p = await getPage();
      pageHandedOff = true;
      p.showLink({ link, emailedTo: emailed ? recipient : '' }).catch(() => {}).finally(() => p.close());
    }

    const lines = [`Sent ${name} (${formatSize(sizeBytes)}).`];
    if (emailed) {
      lines.push(`VitalSend emailed the download link to ${recipient}.`);
    } else {
      if (recipient) lines.push(`VitalSend could not email the link to ${recipient}.`);
      lines.push(linkShown ? 'The download link was shown to the user to share; it was not given to you.' : 'The download link is waiting in the user\'s browser to be shared; it was not given to you.');
    }
    const expiry = formatExpiry(reserved.expiresAt);
    if (expiry) lines.push(`It can be downloaded once, until ${expiry}.`);
    if (password) lines.push('A password was set and shown to the user' + (inDialogs ? '' : ' in the browser') + '. The recipient needs it; the user should send it another way than the link.');
    lines.push(`Cost: ${creditsNeeded} credit${creditsNeeded === 1 ? '' : 's'}.`);
    return { isError: false, text: lines.join(' ') };
  } catch (err) {
    if (err?.inputRequired) throw err;
    return explain(err);
  } finally {
    if (page && !pageHandedOff) page.close();
  }
}
