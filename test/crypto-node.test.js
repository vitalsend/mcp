// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, openAsBlob } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptAndUpload, decryptAndDownload, generatePassword } from '../src/crypto.js';

async function roundTrip(password) {
  const dir = await promisify(mkdtemp)(join(tmpdir(), 'vs-mcp-'));
  const path = join(dir, 'secret.env');
  const original = randomBytes(300_000);
  await promisify(writeFile)(path, original);
  const blob = await openAsBlob(path);

  let header = null;
  const parts = [];
  const linkKey = await encryptAndUpload({
    file: blob,
    password,
    chunkSize: 64 * 1024,
    uploadHeader: async (bytes) => { header = bytes; },
    uploadPart: async (index, bytes) => { parts[index] = bytes; },
  });

  const out = [];
  await decryptAndDownload({
    fetchHeader: async () => header,
    fetchPartStream: async function* () { yield* parts; },
    linkKey,
    password,
    onPlainChunk: async (chunk) => { out.push(Buffer.from(chunk)); },
  });
  return { original, decrypted: Buffer.concat(out) };
}

describe('crypto under Node', () => {
  it('round-trips a file from disk without a password', async () => {
    const { original, decrypted } = await roundTrip(null);
    expect(decrypted.equals(original)).toBe(true);
  });

  it('round-trips a file from disk with a password', async () => {
    const { original, decrypted } = await roundTrip(generatePassword());
    expect(decrypted.equals(original)).toBe(true);
  });

  it('generates passwords like the send page', () => {
    const a = generatePassword();
    expect(a).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(generatePassword()).not.toBe(a);
  });
});
