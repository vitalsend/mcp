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
