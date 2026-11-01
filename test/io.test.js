// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { createIo, NeedInput } from '../src/io.js';

const serverWith = (caps, roots = []) => ({
  server: { getClientCapabilities: () => caps, listRoots: vi.fn(async () => ({ roots: roots.map((uri) => ({ uri })) })) },
});

describe('io, 2025-era connections', () => {
  it('confirms through form elicitation', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'accept' }));
    const io = createIo({ server: serverWith({ elicitation: {} }), ctx: { mcpReq: { elicitInput } }, openBrowser: vi.fn() });
    expect(await io.confirm({ recipient: 'a@x.se', name: 'f', sizeBytes: 1, credits: 1 })).toBe('send');
    elicitInput.mockResolvedValueOnce({ action: 'decline' });
    expect(await io.confirm({ recipient: '', name: 'f', sizeBytes: 1, credits: 1 })).toBe('cancel');
    expect(JSON.stringify(elicitInput.mock.calls)).not.toMatch(/https?:/);
  });

  it('without elicitation, confirmation falls back and login opens the browser', async () => {
    const openBrowser = vi.fn();
    const io = createIo({ server: serverWith({}), ctx: { mcpReq: {} }, openBrowser });
    expect(await io.confirm({ recipient: '', name: 'f', sizeBytes: 1, credits: 1 })).toBe('unavailable');
    await io.openLogin('https://vitalsend.eu/oauth/authorize/?x');
    expect(openBrowser).toHaveBeenCalledWith('https://vitalsend.eu/oauth/authorize/?x');
    expect(await io.roots()).toBeNull();
  });

  it('uses URL elicitation for login when offered, and lists roots', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'accept' }));
    const openBrowser = vi.fn();
    const io = createIo({ server: serverWith({ elicitation: { url: {} }, roots: {} }, ['file:///p']), ctx: { mcpReq: { elicitInput } }, openBrowser });
    await io.openLogin('https://vitalsend.eu/oauth/authorize/?x');
    expect(elicitInput.mock.calls[0][0]).toMatchObject({ mode: 'url', url: 'https://vitalsend.eu/oauth/authorize/?x' });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(await io.roots()).toEqual(['file:///p']);
  });
});

describe('io, secrets in client dialogs', () => {
  it('a 2025-era client with form dialogs shows the password in the confirmation and the link in its own dialog', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'accept' }));
    const io = createIo({ server: serverWith({ elicitation: {} }), ctx: { mcpReq: { elicitInput } }, openBrowser: vi.fn() });
    expect(io.canShowSecrets).toBe(true);
    expect(await io.confirm({ recipient: 'a@x.se', name: 'f', sizeBytes: 1, credits: 1, password: 'QWERTYUP23' })).toBe('send');
    expect(elicitInput.mock.calls[0][0].message).toContain('QWERTYUP23');
    expect(await io.showLink('https://vitalsend.eu/download/?file=VS11x#k=abc')).toBe('accept');
    expect(elicitInput.mock.calls[1][0].message).toContain('https://vitalsend.eu/download/?file=VS11x#k=abc');
  });

  it('other clients cannot show secrets', () => {
    expect(createIo({ server: serverWith({}), ctx: { mcpReq: {} }, openBrowser: vi.fn() }).canShowSecrets).toBe(false);
    expect(createIo({ server: serverWith({ elicitation: {} }), ctx: { mcpReq: { envelope: {} } }, openBrowser: vi.fn() }).canShowSecrets).toBe(false);
  });
});

describe('io, 2025-era URL login', () => {
  const loginFake = () => {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    return { done, resolve, cancel: vi.fn() };
  };
  const serverWithNotifier = () => {
    const sent = [];
    const s = serverWith({ elicitation: { url: {} } });
    s.server.createElicitationCompletionNotifier = (id) => async () => { sent.push(id); };
    return { s, sent };
  };

  it('does not wait for the dialog, and closes it when the login completes', async () => {
    const elicitInput = vi.fn(() => new Promise(() => {}));
    const { s, sent } = serverWithNotifier();
    const login = loginFake();
    const io = createIo({ server: s, ctx: { mcpReq: { elicitInput } }, openBrowser: vi.fn() });
    await io.openLogin('https://vitalsend.eu/oauth/authorize/?x', login);
    expect(sent).toEqual([]);
    login.resolve({});
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([elicitInput.mock.calls[0][0].elicitationId]);
    expect(login.cancel).not.toHaveBeenCalled();
  });

  it('a declined dialog cancels the login', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'decline' }));
    const { s } = serverWithNotifier();
    const login = loginFake();
    const io = createIo({ server: s, ctx: { mcpReq: { elicitInput } }, openBrowser: vi.fn() });
    await io.openLogin('https://vitalsend.eu/oauth/authorize/?x', login);
    await new Promise((r) => setTimeout(r, 0));
    expect(login.cancel).toHaveBeenCalled();
  });
});

describe('io, 2026-07-28 connections', () => {
  const ctx2026 = (inputResponses) => ({ mcpReq: { envelope: {}, inputResponses } });

  it('asks for confirmation with inputRequired, then reads the answer on retry', async () => {
    const server = serverWith({ elicitation: { form: {} } });
    const first = createIo({ server, ctx: ctx2026(undefined), openBrowser: vi.fn() });
    const err = await first.confirm({ recipient: '', name: 'f', sizeBytes: 1, credits: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(NeedInput);
    expect(JSON.stringify(err.value)).toContain('confirm');
    const retry = createIo({ server, ctx: ctx2026({ confirm: { action: 'accept' } }), openBrowser: vi.fn() });
    expect(await retry.confirm({ recipient: '', name: 'f', sizeBytes: 1, credits: 1 })).toBe('send');
  });

  it('asks for roots and the login URL the same way', async () => {
    const server = serverWith({ elicitation: { url: {} }, roots: {} });
    const io = createIo({ server, ctx: ctx2026(undefined), openBrowser: vi.fn() });
    await expect(io.roots()).rejects.toBeInstanceOf(NeedInput);
    await expect(io.openLogin('https://vitalsend.eu/oauth/authorize/?x')).rejects.toBeInstanceOf(NeedInput);
    const retry = createIo({ server, ctx: ctx2026({ roots: { roots: [{ uri: 'file:///p' }] }, login: { action: 'accept' } }), openBrowser: vi.fn() });
    expect(await retry.roots()).toEqual(['file:///p']);
    await expect(retry.openLogin('https://vitalsend.eu/oauth/authorize/?x')).resolves.toBeUndefined();
  });
});
