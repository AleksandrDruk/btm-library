const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PASSWORD_PREFIX = 'pbkdf2-sha256';
// Cloudflare Workers rejects PBKDF2 requests above 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;

export function bytesToBase64(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const chunk = input.subarray(offset, Math.min(offset + chunkSize, input.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4 || 4)) % 4);
  return base64ToBytes(padded);
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') {
    throw new Error('Password hash is missing.');
  }
  const [prefix, iterationText, saltText, hashText] = encoded.split('$');
  const iterations = Number(iterationText);
  if (
    prefix !== PASSWORD_PREFIX
    || !Number.isInteger(iterations)
    || iterations !== PASSWORD_ITERATIONS
    || !saltText
    || !hashText
  ) {
    throw new Error('Password hash has an invalid format.');
  }
  const salt = base64ToBytes(saltText);
  const hash = base64ToBytes(hashText);
  if (salt.length < 16 || hash.length !== 32) {
    throw new Error('Password hash has an invalid length.');
  }
  return { iterations, salt, hash };
}

export async function createPasswordHash(password, iterations = PASSWORD_ITERATIONS) {
  if (typeof password !== 'string' || password.length < 20) {
    throw new Error('Password must contain at least 20 characters.');
  }
  if (iterations !== PASSWORD_ITERATIONS) {
    throw new Error(`Password hash must use exactly ${PASSWORD_ITERATIONS} iterations.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, iterations);
  return `${PASSWORD_PREFIX}$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
    return false;
  }
  const { iterations, salt, hash } = parsePasswordHash(encodedHash);
  const candidate = await derivePassword(password, salt, iterations);
  const challenge = encoder.encode('btm-password-check-v1');
  const candidateKey = await crypto.subtle.importKey('raw', candidate, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expectedKey = await crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = await crypto.subtle.sign('HMAC', candidateKey, challenge);
  return crypto.subtle.verify('HMAC', expectedKey, signature, challenge);
}

async function importSessionKey(secret, usage) {
  const bytes = base64ToBytes(secret);
  if (bytes.length < 32) {
    throw new Error('Session secret must contain at least 32 bytes.');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function createSessionToken(secret, ttlSeconds, version = '1') {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: String(version),
    iat: now,
    exp: now + Math.max(300, Math.min(3600, Number(ttlSeconds) || 1800)),
    nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18))),
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importSessionKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload));
  return `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token, secret, version = '1') {
  if (typeof token !== 'string' || token.length > 2048) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  try {
    const key = await importSessionKey(secret, ['verify']);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(parts[1]),
      encoder.encode(parts[0]),
    );
    if (!valid) {
      return null;
    }
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[0])));
    const now = Math.floor(Date.now() / 1000);
    if (
      payload === null
      || typeof payload !== 'object'
      || payload.v !== String(version)
      || !Number.isInteger(payload.iat)
      || !Number.isInteger(payload.exp)
      || typeof payload.nonce !== 'string'
      || payload.iat > now + 60
      || payload.exp <= now
      || payload.exp - payload.iat > 3600
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function shortDigest(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
  return bytesToBase64Url(digest.subarray(0, 18));
}

export async function sha256Hex(value) {
  let bytes;
  if (typeof value === 'string') {
    bytes = encoder.encode(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError('SHA-256 input must be text or bytes.');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
