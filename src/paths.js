// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// Which files the tool may read: only inside the client's MCP roots, or the
// directory the package was started in when the client gives none. Symlinks
// are resolved first, so a link inside a root cannot point outside it.
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export class PathNotAllowed extends Error {
  constructor() {
    super('That file is outside the folders this tool may read, or is not a file.');
    this.name = 'PathNotAllowed';
  }
}

export class RootRequired extends Error {
  constructor() {
    super('This app does not tell the tool which folder you work in. Set VITALSEND_ROOT to that folder in the tool\'s MCP configuration.');
    this.name = 'RootRequired';
  }
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
};

async function realOrNull(p) {
  try { return await realpath(p); } catch (_err) { return null; }
}

// Without client roots the allowed folder is VITALSEND_ROOT, else the start
// directory; a start directory of / or the home directory would open the
// whole disk to a prompt-injected agent, so it is refused.
export async function resolveAllowedFile(path, { roots, cwd, envRoot = '', home = homedir() }) {
  let rootDirs;
  if (roots && roots.length) {
    rootDirs = roots.map((r) => (String(r).startsWith('file:') ? fileURLToPath(r) : String(r)));
  } else if (envRoot) {
    rootDirs = [envRoot];
  } else {
    const start = resolve(cwd);
    if (start === resolve('/') || start === resolve(home)) throw new RootRequired();
    rootDirs = [start];
  }
  const realRoots = (await Promise.all(rootDirs.map(realOrNull))).filter(Boolean);
  const base = realRoots[0] || cwd;
  const real = await realOrNull(resolve(base, String(path || '')));
  if (!real || !realRoots.some((root) => inside(real, root))) throw new PathNotAllowed();
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new PathNotAllowed();
  return real;
}
