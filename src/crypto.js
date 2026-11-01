// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// The crypto core is the code vitalsend.eu ships to browsers
// (frontend/src/js/crypto, mirrored as github.com/vitalsend/crypto),
// bundled in unchanged.
import { randomInt } from 'node:crypto';

export {
  encryptAndUpload,
  decryptAndDownload,
  encodeLinkKey,
  buildShareLink,
  derivePasswordVerifier,
  normalizePassword,
} from '../vendor/crypto/index.js';

// Same alphabet and length as the send page (generatePassword in
// frontend/src/js/vitalsend.js): no I, O, 0 or 1, about 50 bits.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 10;

export function generatePassword() {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}
