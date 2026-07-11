import { buildCatalogUpdate, CatalogError, serializeCatalog, validateCatalog } from '../lib/catalog.js';
import { createSessionToken, shortDigest, verifyPassword, verifySessionToken } from '../lib/crypto.js';
import { ImageValidationError, inspectImage, MAX_IMAGE_BYTES } from '../lib/image.js';
import { createUploadPullRequest, getRepositorySnapshot, GitHubApiError } from './github.js';

const API_VERSION = '1.0.0';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function safeErrorKind(error) {
  const name = error instanceof Error ? error.name : '';
  return new Map([
    ['DataError', 'data_error'],
    ['Error', 'error'],
    ['NotSupportedError', 'not_supported_error'],
    ['OperationError', 'operation_error'],
    ['TypeError', 'type_error'],
  ]).get(name) || 'unknown_error';
}

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).has(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function jsonResponse(payload, status, origin, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(origin, env),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function requireOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).has(origin)) {
    throw new ApiError(403, 'origin_denied', 'Запрос отправлен с недоверенного сайта.');
  }
  return origin;
}

function requireConfigured(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new ApiError(503, 'service_not_configured', 'Сервис ещё не настроен администратором.');
  }
  if (env.ENVIRONMENT === 'production' && env.TURNSTILE_SECRET === TURNSTILE_TEST_SECRET) {
    throw new ApiError(503, 'test_secret_forbidden', 'Production Turnstile ещё не настроен.');
  }
}

async function enforceRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== 'function') {
    throw new ApiError(503, 'rate_limiter_missing', 'Защита от частых запросов не настроена.');
  }
  const result = await binding.limit({ key });
  if (!result?.success) {
    throw new ApiError(429, 'rate_limited', 'Слишком много запросов. Повторите попытку позже.');
  }
}

async function validateTurnstile(token, request, env, fetchImpl) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) {
    return false;
  }
  const payload = new FormData();
  payload.set('secret', env.TURNSTILE_SECRET);
  payload.set('response', token);
  const remoteIp = request.headers.get('CF-Connecting-IP');
  if (remoteIp) {
    payload.set('remoteip', remoteIp);
  }

  const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: payload,
  });
  if (!response.ok) {
    return false;
  }
  const result = await response.json();
  return result.success === true
    && result.action === 'btm_login'
    && result.hostname === env.TURNSTILE_HOSTNAME;
}

async function readSmallJson(request) {
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > 8192) {
    throw new ApiError(413, 'request_too_large', 'Запрос слишком большой.');
  }
  const text = await request.text();
  if (text.length > 8192) {
    throw new ApiError(413, 'request_too_large', 'Запрос слишком большой.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'Некорректный JSON.');
  }
}

async function handleLogin(request, env, origin, fetchImpl) {
  requireConfigured(env, ['PASSWORD_HASH', 'SESSION_SECRET', 'TURNSTILE_SECRET', 'TURNSTILE_HOSTNAME']);
  const fingerprint = await shortDigest([
    request.headers.get('CF-Connecting-IP') || 'unknown',
    request.headers.get('User-Agent') || 'unknown',
  ].join('|'));
  await enforceRateLimit(env.LOGIN_RATE_LIMITER, `login:${fingerprint}`);

  const body = await readSmallJson(request);
  let turnstileValid;
  try {
    turnstileValid = await validateTurnstile(body.turnstile_token, request, env, fetchImpl);
  } catch {
    throw new ApiError(502, 'turnstile_unavailable', 'Проверка безопасности временно недоступна.');
  }

  let passwordValid = false;
  if (turnstileValid) {
    try {
      passwordValid = await verifyPassword(body.password, env.PASSWORD_HASH);
    } catch (error) {
      throw new ApiError(
        503,
        `password_verifier_${safeErrorKind(error)}`,
        'Проверка пароля временно недоступна.',
      );
    }
  }
  if (!turnstileValid || !passwordValid) {
    throw new ApiError(401, 'access_denied', 'Неверный пароль или проверка безопасности.');
  }

  let token;
  try {
    token = await createSessionToken(
      env.SESSION_SECRET,
      Number(env.SESSION_TTL_SECONDS || 1800),
      env.SESSION_VERSION || '1',
    );
  } catch {
    throw new ApiError(503, 'session_issuer_unavailable', 'Сессия временно недоступна.');
  }
  return jsonResponse({ ok: true, token, expires_in: Number(env.SESSION_TTL_SECONDS || 1800) }, 200, origin, env);
}

async function requireSession(request, env) {
  requireConfigured(env, ['SESSION_SECRET']);
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]{20,2048})$/);
  if (!match) {
    throw new ApiError(401, 'session_required', 'Сессия отсутствует или истекла.');
  }
  const payload = await verifySessionToken(match[1], env.SESSION_SECRET, env.SESSION_VERSION || '1');
  if (!payload) {
    throw new ApiError(401, 'session_invalid', 'Сессия отсутствует или истекла.');
  }
  return payload;
}

function contentLength(request) {
  const raw = request.headers.get('Content-Length');
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function handleUpload(request, env, origin, fetchImpl) {
  requireConfigured(env, ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']);
  const session = await requireSession(request, env);
  await enforceRateLimit(env.UPLOAD_RATE_LIMITER, `upload:${session.nonce}`);

  const declaredLength = contentLength(request);
  if (declaredLength !== null && declaredLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'request_too_large', 'Общий размер партии превышает 32 МБ.');
  }

  const form = await request.formData();
  const metadataText = form.get('metadata');
  if (typeof metadataText !== 'string' || metadataText.length > MAX_METADATA_BYTES) {
    throw new ApiError(400, 'metadata_invalid', 'Параметры партии отсутствуют или слишком велики.');
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new ApiError(400, 'metadata_invalid', 'Параметры партии содержат некорректный JSON.');
  }
  if (!Array.isArray(metadata) || metadata.length < 1 || metadata.length > 20) {
    throw new ApiError(400, 'metadata_invalid', 'За один раз разрешено от 1 до 20 операций.');
  }

  const entries = [];
  const filesByIndex = new Map();
  let totalFileBytes = 0;
  for (let index = 0; index < metadata.length; index += 1) {
    const entry = metadata[index];
    if (entry?.mode === 'delete') {
      entries.push({ mode: 'delete', asset_id: entry.asset_id, purge_file: entry.purge_file === true });
      continue;
    }

    const file = form.get(`file_${index}`);
    if (!(file instanceof File)) {
      throw new ApiError(400, 'file_missing', `Файл ${index + 1} отсутствует.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = inspectImage(bytes);
    if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new ApiError(400, 'declared_mime_invalid', `Файл ${index + 1} имеет неподдерживаемый MIME.`);
    }
    if (file.type && file.type !== image.mime) {
      throw new ApiError(400, 'mime_mismatch', `Файл ${index + 1}: расширение или MIME не совпадает с содержимым.`);
    }
    totalFileBytes += bytes.byteLength;
    if (totalFileBytes > MAX_REQUEST_BYTES - MAX_METADATA_BYTES) {
      throw new ApiError(413, 'batch_too_large', 'Общий размер изображений превышает лимит партии.');
    }
    filesByIndex.set(index, { bytes, image, original_name: file.name.slice(0, 180) });
    entries.push({
      mode: entry?.mode,
      asset_id: entry?.asset_id,
      brand: entry?.brand,
      variant: entry?.variant,
      suggested_filename: entry?.suggested_filename,
      tags: entry?.tags,
      image,
    });
  }

  const snapshot = await getRepositorySnapshot(env, fetchImpl);
  const currentCatalog = validateCatalog(snapshot.catalog);
  const update = buildCatalogUpdate(currentCatalog, entries);
  const result = await createUploadPullRequest(
    snapshot,
    serializeCatalog(update.catalog),
    update.changes,
    filesByIndex,
    fetchImpl,
  );

  const expectedPrefix = `https://github.com/${snapshot.coordinates.owner}/${snapshot.coordinates.repo}/pull/`;
  if (typeof result.url !== 'string' || !result.url.startsWith(expectedPrefix)) {
    throw new ApiError(502, 'github_url_invalid', 'GitHub вернул неожиданный адрес PR.');
  }

  return jsonResponse({ ok: true, pull_request: result }, 201, origin, env);
}

export async function handleRequest(request, env, context = {}, fetchImpl = fetch) {
  const url = new URL(request.url);
  const requestOrigin = request.headers.get('Origin');

  try {
    if (request.method === 'OPTIONS') {
      const origin = requireOrigin(request, env);
      return new Response(null, { status: 204, headers: { ...securityHeaders(), ...corsHeaders(origin, env) } });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const ready = Boolean(
        env.PASSWORD_HASH
        && env.SESSION_SECRET
        && env.TURNSTILE_SECRET
        && env.GITHUB_APP_ID
        && env.GITHUB_APP_PRIVATE_KEY,
      );
      return jsonResponse({ ok: true, ready, version: API_VERSION }, 200, requestOrigin, env);
    }

    const origin = requireOrigin(request, env);
    if (request.method === 'POST' && url.pathname === '/login') {
      return await handleLogin(request, env, origin, fetchImpl);
    }
    if (request.method === 'POST' && url.pathname === '/upload') {
      return await handleUpload(request, env, origin, fetchImpl);
    }
    throw new ApiError(404, 'not_found', 'Endpoint не найден.');
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse({ ok: false, code: error.code, message: error.message }, error.status, requestOrigin, env);
    }
    if (error instanceof CatalogError || error instanceof ImageValidationError) {
      return jsonResponse({ ok: false, code: error.code, message: error.message }, 400, requestOrigin, env);
    }
    if (error instanceof GitHubApiError) {
      return jsonResponse({ ok: false, code: error.code, message: error.message }, error.status, requestOrigin, env);
    }
    return jsonResponse({ ok: false, code: 'internal_error', message: 'Внутренняя ошибка сервиса.' }, 500, requestOrigin, env);
  }
}

export default {
  fetch(request, env, context) {
    return handleRequest(request, env, context, fetch);
  },
};

export const limits = {
  maxImageBytes: MAX_IMAGE_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
};
