// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// Opens a URL in the user's default browser, without a shell.
import { spawn } from 'node:child_process';

export async function openBrowser(url, platform = process.platform) {
  const [cmd, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
