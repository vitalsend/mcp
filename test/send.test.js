// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendFile } from '../src/send.js';
import { ApiError } from '../src/api.js';
import { LoginRequired } from '../src/credentials.js';
import { BrowserUnavailable } from '../src/delivery-page.js';

const LINK_BASE = 'https://vitalsend.eu/download/?file=VS11secretfileid';
const ACCESS = 'access-token-secret';

async function project() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vs-send-')));
  await writeFile(join(dir, 'report.pdf'), Buffer.alloc(2048, 7));
  return dir;
}

// Everything sendFile talks to, recording what happened.
function world({ mode = 'oauth', confirm = 'send', passwordResult = 'saved', fail = {}, noBrowser = false, linkRejects = false } = {}) {
  const calls = [];
  const page = {
    open: vi.fn(async () => { if (noBrowser) throw new BrowserUnavailable(); }),
    confirm: vi.fn(async () => confirm),
    showPassword: vi.fn(async (pw) => { calls.push(['showPassword', pw]); return passwordResult; }),
    showLink: vi.fn(async () => { if (linkRejects) throw new BrowserUnavailable(); return 'done'; }),
    close: vi.fn(),
  };
  const session = {};
  for (const step of ['init', 'quote', 'reserve', 'upload', 'complete', 'link', 'sendEmail']) {
    session[step] = vi.fn(async (args) => {
      calls.push([step, args]);
      if (fail[step]) throw fail[step];
      if (step === 'quote') return { creditsNeeded: 1 };
      if (step === 'reserve') return { expiresAt: '2026-11-08T10:00:00Z', creditsNeeded: 1 };
      if (step === 'link') return LINK_BASE;
      return undefined;
    });
  }
  const deps = {
    credentials: {
      mode: vi.fn(async () => mode),
      accessToken: vi.fn(async () => { if (mode === 'none') throw new LoginRequired(); return ACCESS; }),
      adopt: vi.fn(async () => ACCESS),
    },
    newSession: vi.fn(() => session),
    openPage: vi.fn(async () => page),
    startLogin: vi.fn(async () => ({ url: 'https://vitalsend.eu/oauth/authorize/?x', done: Promise.resolve({ accessToken: ACCESS, refreshToken: 'vsr_r' }) })),
    io: {
      roots: vi.fn(async () => null),
      openLogin: vi.fn(async () => {}),
      confirm: vi.fn(async () => (confirm === 'send' ? 'send' : 'cancel')),
    },
    clientName: 'Cursor',
  };
  return { deps, calls, page, session };
}

const SECRETS = (calls) => {
  const pw = calls.find((c) => c[0] === 'showPassword')?.[1];
  return [LINK_BASE, 'VS11secretfileid', '#k=', ACCESS, 'vsr_', ...(pw ? [pw] : [])];
};

function expectNoSecrets(text, calls) {
  for (const s of SECRETS(calls)) expect(text).not.toContain(s);
  expect(text).not.toMatch(/127\.0\.0\.1/);
}

describe('sendFile', () => {
  it('emails the link and tells the model only who, when and the cost', async () => {
    const cwd = await project();
    const { deps, calls } = world();
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'kalle@example.com' }, { ...deps, cwd });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('kalle@example.com');
    expect(out.text).toContain('2026-11-08');
    expectNoSecrets(out.text, calls);
    const email = calls.find((c) => c[0] === 'sendEmail')[1];
    expect(email.link.startsWith(LINK_BASE + '#k=')).toBe(true);
    const reserve = calls.find((c) => c[0] === 'reserve')[1];
    const pw = calls.find((c) => c[0] === 'showPassword')[1];
    expect(reserve.passwordVerifier).toBeTruthy();
    expect(reserve.passwordVerifier).not.toContain(pw);
  });

  it('shows the password before anything is reserved, and spends nothing when it times out', async () => {
    const cwd = await project();
    const { deps, calls } = world({ passwordResult: 'timeout' });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'kalle@example.com' }, { ...deps, cwd });
    expect(out.isError).toBe(true);
    expect(calls.map((c) => c[0])).not.toContain('reserve');
    expectNoSecrets(out.text, calls);
  });

  it('a declined confirmation reserves nothing', async () => {
    const cwd = await project();
    const { deps, calls } = world({ confirm: 'cancel' });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'kalle@example.com' }, { ...deps, cwd });
    expect(out.isError).toBe(true);
    expect(calls.map((c) => c[0])).not.toContain('reserve');
  });

  it('without a recipient the link waits on the user page', async () => {
    const cwd = await project();
    const { deps, calls, page } = world();
    const out = await sendFile({ path: 'report.pdf', password: false }, { ...deps, cwd });
    expect(out.isError).toBeFalsy();
    expect(calls.map((c) => c[0])).not.toContain('sendEmail');
    expect(page.showLink).toHaveBeenCalledWith(expect.objectContaining({ emailedTo: '' }));
    expectNoSecrets(out.text, calls);
  });

  it('API-key mode refuses a password or a missing recipient before any call', async () => {
    const cwd = await project();
    for (const input of [{ path: 'report.pdf', recipient_email: 'a@x.se', password: true }, { path: 'report.pdf' }]) {
      const { deps, calls } = world({ mode: 'api_key' });
      const out = await sendFile(input, { ...deps, cwd });
      expect(out.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(deps.newSession).not.toHaveBeenCalled();
    }
  });

  it('API-key mode sends without confirmation or password by default', async () => {
    const cwd = await project();
    const { deps, calls } = world({ mode: 'api_key' });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'a@x.se' }, { ...deps, cwd });
    expect(out.isError).toBeFalsy();
    expect(deps.io.confirm).not.toHaveBeenCalled();
    expect(calls.map((c) => c[0])).not.toContain('showPassword');
    expect(calls.find((c) => c[0] === 'reserve')[1].passwordVerifier).toBe('');
  });

  it('a path outside the allowed folder is refused before anything happens', async () => {
    const cwd = await project();
    const { deps, calls } = world();
    const out = await sendFile({ path: '/etc/hosts', recipient_email: 'a@x.se' }, { ...deps, cwd });
    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(deps.openPage).not.toHaveBeenCalled();
  });

  it('logs in first when needed, then sends', async () => {
    const cwd = await project();
    const { deps } = world({ mode: 'none' });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'a@x.se' }, { ...deps, cwd });
    expect(deps.io.openLogin).toHaveBeenCalledWith('https://vitalsend.eu/oauth/authorize/?x');
    expect(deps.credentials.adopt).toHaveBeenCalled();
    expect(out.isError).toBeFalsy();
  });

  it('no failure leaks a secret into the result', async () => {
    const cwd = await project();
    const failures = [
      ['upload', new ApiError('network')],
      ['reserve', new ApiError('credits_insufficient', 403)],
      ['sendEmail', new ApiError('recipient_not_allowed', 403)],
      ['complete', new ApiError('server', 500)],
      ['link', new Error(`boom ${LINK_BASE}#k=abc ${ACCESS}`)],
    ];
    for (const [step, err] of failures) {
      const { deps, calls } = world({ fail: { [step]: err } });
      const out = await sendFile({ path: 'report.pdf', recipient_email: 'a@x.se' }, { ...deps, cwd });
      // A failed email after upload is a partial success (the link goes to the user's page).
      if (step !== 'sendEmail') expect(out.isError).toBe(true);
      expectNoSecrets(out.text, calls);
      expect(out.text).not.toContain('boom');
    }
  });

  it('a failed email after upload hands the link to the user page and says so', async () => {
    const cwd = await project();
    const { deps, calls, page } = world({ fail: { sendEmail: new ApiError('server', 409) } });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'kalle@example.com' }, { ...deps, cwd });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/could not email/i);
    expect(page.showLink).toHaveBeenCalledWith(expect.objectContaining({ emailedTo: '' }));
    expectNoSecrets(out.text, calls);
  });

  it('with an API key, a failed email says the credit was used and the link is lost', async () => {
    const cwd = await project();
    const { deps, calls } = world({ mode: 'api_key', fail: { sendEmail: new ApiError('server', 409) } });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'a@x.se' }, { ...deps, cwd });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/credit/i);
    expect(out.text).toMatch(/could not email/i);
    expectNoSecrets(out.text, calls);
  });

  it('a recipient refused at quote spends nothing', async () => {
    const cwd = await project();
    const { deps, calls } = world({ mode: 'api_key', fail: { quote: new ApiError('recipient_not_allowed', 403) } });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'b@x.se' }, { ...deps, cwd });
    expect(out.isError).toBe(true);
    expect(calls.find((c) => c[0] === 'quote')[1].recipient).toBe('b@x.se');
    expect(calls.map((c) => c[0])).not.toContain('reserve');
  });

  it('opens the browser before anything is reserved; without one nothing is spent', async () => {
    const cwd = await project();
    const { deps, calls } = world({ noBrowser: true });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'a@x.se', password: false }, { ...deps, cwd });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/browser/i);
    expect(calls.map((c) => c[0])).not.toContain('reserve');
  });

  it('a failing link view after the send never becomes an unhandled rejection', async () => {
    const cwd = await project();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { deps } = world({ linkRejects: true });
    const out = await sendFile({ path: 'report.pdf', recipient_email: 'a@x.se' }, { ...deps, cwd });
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', unhandled);
    expect(out.isError).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
