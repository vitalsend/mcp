// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// VitalSend's HTTP API as the web page uses it (frontend/src/js/vitalsend-api.js):
// the token endpoint for connections, and the send flow under
// /api/v1/managedsend. Errors carry a code only, never a URL, token or body,
// since an error may end up in front of the model.
import { encryptAndUpload } from './crypto.js';

export const CLIENT_ID = 'vitalsend-mcp';
const API_KEY_GRANT = 'urn:vitalsend:params:oauth:grant-type:api-key';
const FLOW = '/api/v1/managedsend';
const STEP_TOKEN_SKEW_MS = 30_000;
const PART_ATTEMPTS = 3;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

const MESSAGES = {
  credits_insufficient: 'Not enough credits.',
  recipient_not_allowed: 'This API key may not send to that recipient.',
  invalid_grant: 'The VitalSend login is no longer valid.',
  unauthorized: 'VitalSend refused the request.',
  network: 'VitalSend could not be reached.',
  server: 'VitalSend could not complete the request.',
};

export class ApiError extends Error {
  constructor(code, status = 0) {
    super(MESSAGES[code] || MESSAGES.server);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// Never follow a redirect: the access token and step tokens must not leave
// for another origin.
async function send(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (_err) {
    throw new ApiError('network');
  }
}

async function readJSON(res) {
  try {
    return await res.json();
  } catch (_err) {
    return {};
  }
}

async function failure(res) {
  const data = await readJSON(res);
  if (data?.code === 'credits_insufficient' || data?.code === 'recipient_not_allowed') {
    return new ApiError(data.code, res.status);
  }
  if (data?.error === 'invalid_grant') return new ApiError('invalid_grant', res.status);
  if (res.status === 401 || res.status === 403) return new ApiError('unauthorized', res.status);
  return new ApiError('server', res.status);
}

export function createTokenClient({ baseUrl, fetchImpl = fetch }) {
  const token = async (form) => {
    const res = await send(fetchImpl, `${baseUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) throw await failure(res);
    const data = await readJSON(res);
    return {
      accessToken: data.access_token || '',
      expiresIn: Number(data.expires_in || 0),
      refreshToken: data.refresh_token || '',
    };
  };
  return {
    exchangeCode: ({ code, verifier, redirectUri }) => token({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: CLIENT_ID,
    }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    exchangeAPIKey: (apiKey) => token({ grant_type: API_KEY_GRANT, api_key: apiKey }),
  };
}

function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return Number(payload.exp || 0) * 1000;
  } catch (_err) {
    return 0;
  }
}

// One send through the flow. The access token travels in the vitalsend_jwt
// cookie because the flow's Authorization header carries its step tokens.
export function createSendSession({ baseUrl, accessToken, fetchImpl = fetch }) {
  const cookies = new Map([['vitalsend_jwt', accessToken]]);
  let stepToken = '';
  let fileId = '';
  let uploadId = '';

  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const keepCookies = (res) => {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const request = async (path, { body, headers = {}, raw = false } = {}) => {
    const res = await send(fetchImpl, `${baseUrl}${FLOW}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(),
        ...(stepToken ? { Authorization: `Bearer ${stepToken}` } : {}),
        ...(raw ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: raw ? body : JSON.stringify(body ?? {}),
    });
    keepCookies(res);
    return res;
  };
  const refreshStep = async () => {
    const res = await request('/prepare/refresh', { body: { file_id: fileId } });
    if (!res.ok) throw await failure(res);
    const data = await readJSON(res);
    if (data.step_token) stepToken = data.step_token;
  };
  // Refreshes an expiring step token first, and once more on a 401, as the web page does.
  const call = async (path, body) => {
    if (fileId && stepToken && jwtExpiresAt(stepToken) - Date.now() < STEP_TOKEN_SKEW_MS && jwtExpiresAt(stepToken) > 0) {
      await refreshStep();
    }
    let res = await request(path, { body });
    if (res.status === 401 && fileId) {
      await refreshStep();
      res = await request(path, { body });
    }
    if (!res.ok) throw await failure(res);
    const data = await readJSON(res);
    if (data.step_token) stepToken = data.step_token;
    return data;
  };
  const postPart = async (bytes, offset, chunkIndex) => {
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt += 1) {
      const res = await request('/prepare/part', {
        raw: true,
        body: bytes,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Vitalsend-Upload-Id': uploadId,
          'X-Vitalsend-Upload-Offset': String(offset),
          ...(Number.isInteger(chunkIndex) ? { 'X-Vitalsend-Chunk-Index': String(chunkIndex) } : {}),
        },
      });
      if (res.ok) return;
      if (res.status === 401) {
        await refreshStep();
        continue;
      }
      if (res.status === 429 && attempt < PART_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw await failure(res);
    }
    throw new ApiError('server');
  };

  return {
    async init() {
      stepToken = '';
      await call('/init');
    },
    // The recipient lets a connection's allowlist refuse before anything is spent.
    async quote({ sizeBytes, password, recipient = '' }) {
      const data = await call('/quote', { file_size_bytes: sizeBytes, extra_password_enabled: !!password, recipient_email: recipient });
      return { creditsNeeded: Number(data.credits_needed || 0) };
    },
    async reserve({ name, type, sizeBytes, passwordVerifier }) {
      const data = await call('/reserve', {
        filename: name, file_type: type || '', file_size_bytes: sizeBytes, extra_password: passwordVerifier || '',
      });
      fileId = data.file_id || '';
      return { expiresAt: data.expires_at || '', creditsNeeded: Number(data.credits_needed || 0) };
    },
    async upload({ blob, linkKey, password, chunkSize = DEFAULT_CHUNK_SIZE, onProgress }) {
      const started = await call('/prepare/start', { file_id: fileId, restart: false });
      uploadId = started.upload_id || fileId;
      let offset = 0;
      await encryptAndUpload({
        file: blob,
        linkKey,
        password: password || null,
        chunkSize,
        onProgress,
        uploadHeader: async (bytes) => { await postPart(bytes, offset); offset += bytes.length; },
        uploadPart: async (index, bytes) => { await postPart(bytes, offset, index); offset += bytes.length; },
      });
    },
    async complete({ name, type, sizeBytes }) {
      await call('/prepare/complete', {
        upload_id: uploadId || fileId, file_id: fileId, original_filename: name, file_type: type || '', file_size_bytes: sizeBytes,
      });
    },
    async link() {
      const data = await call('/link', { file_id: fileId, payment_id: '' });
      return data.link || '';
    },
    async sendEmail({ recipient, link }) {
      await call('/send-email', { file_id: fileId, recipient_email: recipient, link });
    },
  };
}
