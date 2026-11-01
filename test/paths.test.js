// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAllowedFile, PathNotAllowed, RootRequired } from '../src/paths.js';

async function layout() {
  const top = await realpath(await mkdtemp(join(tmpdir(), 'vs-paths-')));
  const project = join(top, 'project');
  const outside = join(top, 'outside');
  await mkdir(join(project, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, 'sub', '.env'), 'A=1');
  await writeFile(join(outside, 'id_rsa'), 'secret');
  await symlink(join(outside, 'id_rsa'), join(project, 'link-out'));
  await symlink(join(project, 'sub', '.env'), join(project, 'link-in'));
  return { top, project, outside };
}

describe('resolveAllowedFile', () => {
  it('accepts a file inside a root, relative or absolute', async () => {
    const { project } = await layout();
    const roots = [pathToFileURL(project).href];
    expect(await resolveAllowedFile('sub/.env', { roots, cwd: project })).toBe(join(project, 'sub', '.env'));
    expect(await resolveAllowedFile(join(project, 'link-in'), { roots, cwd: project })).toBe(join(project, 'sub', '.env'));
  });

  it('refuses .., absolute paths outside and symlinks pointing out', async () => {
    const { project, outside } = await layout();
    const roots = [pathToFileURL(project).href];
    for (const p of ['../outside/id_rsa', join(outside, 'id_rsa'), 'link-out', 'sub/../../outside/id_rsa']) {
      await expect(resolveAllowedFile(p, { roots, cwd: project })).rejects.toBeInstanceOf(PathNotAllowed);
    }
  });

  it('falls back to the start directory without roots', async () => {
    const { project, outside } = await layout();
    expect(await resolveAllowedFile('sub/.env', { roots: null, cwd: project })).toBe(join(project, 'sub', '.env'));
    await expect(resolveAllowedFile(join(outside, 'id_rsa'), { roots: null, cwd: project })).rejects.toBeInstanceOf(PathNotAllowed);
  });

  it('refuses directories and missing files', async () => {
    const { project } = await layout();
    await expect(resolveAllowedFile('sub', { roots: null, cwd: project })).rejects.toBeInstanceOf(PathNotAllowed);
    await expect(resolveAllowedFile('nope.txt', { roots: null, cwd: project })).rejects.toBeInstanceOf(PathNotAllowed);
  });

  it('refuses to fall back to a home directory or / as the sandbox', async () => {
    const { project } = await layout();
    for (const cwd of ['/', '/Users/someone']) {
      await expect(resolveAllowedFile('x', { roots: null, cwd, home: '/Users/someone' })).rejects.toBeInstanceOf(RootRequired);
    }
    expect(await resolveAllowedFile(join(project, 'sub', '.env'), { roots: null, cwd: '/', home: '/Users/someone', envRoot: project }))
      .toBe(join(project, 'sub', '.env'));
  });

  it('VITALSEND_ROOT narrows like a root, and client roots still win', async () => {
    const { project, outside } = await layout();
    await writeFile(join(project, 'top.txt'), 'in the project, outside VITALSEND_ROOT');
    await expect(resolveAllowedFile(join(project, 'top.txt'), { roots: null, cwd: project, envRoot: join(project, 'sub') })).rejects.toBeInstanceOf(PathNotAllowed);
    expect(await resolveAllowedFile('sub/.env', { roots: [pathToFileURL(project).href], cwd: project, envRoot: outside })).toBe(join(project, 'sub', '.env'));
  });
});
