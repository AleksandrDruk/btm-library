import { validateVisualFingerprint, visualFingerprintsMatch } from './visual-dedupe.js';

export const VISUAL_INDEX_PATH = 'visual-index.json';
export const VISUAL_INDEX_SCHEMA_VERSION = 1;
export const MAX_VISUAL_INDEX_ITEMS = 1000;
export const MAX_VISUAL_INDEX_BYTES = 900 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSIONED_LOGO_PATH = /^logos\/[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9_-]{0,79}-v[1-9][0-9]*\.(?:jpg|png|webp)$/;

export class VisualIndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VisualIndexError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new VisualIndexError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, context) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail('invalid_visual_index', `${context}: набор полей не соответствует схеме.`);
  }
}

function normalizeItem(item, index) {
  if (!isPlainObject(item)) {
    fail('invalid_visual_index', `Visual index ${index + 1}: ожидается объект.`);
  }
  assertExactKeys(item, ['fingerprint', 'path', 'sha256'], `Visual index ${index + 1}`);
  if (typeof item.path !== 'string' || !VERSIONED_LOGO_PATH.test(item.path)) {
    fail('invalid_visual_index', `Visual index ${index + 1}: некорректный path.`);
  }
  if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
    fail('invalid_visual_index', `Visual index ${index + 1}: некорректный SHA-256.`);
  }
  let fingerprint;
  try {
    fingerprint = validateVisualFingerprint(item.fingerprint);
  } catch {
    fail('invalid_visual_index', `Visual index ${index + 1}: некорректный визуальный отпечаток.`);
  }
  return { path: item.path, sha256: item.sha256, fingerprint };
}

export function validateVisualIndex(value) {
  if (!isPlainObject(value)) {
    fail('invalid_visual_index', 'visual-index.json должен содержать объект.');
  }
  assertExactKeys(value, ['catalog_version', 'items', 'schema_version'], 'visual-index.json');
  if (value.schema_version !== VISUAL_INDEX_SCHEMA_VERSION) {
    fail('unsupported_visual_index', 'Версия visual-index.json не поддерживается.');
  }
  if (!Number.isInteger(value.catalog_version) || value.catalog_version < 1) {
    fail('invalid_visual_index', 'visual-index catalog_version должен быть положительным целым.');
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_VISUAL_INDEX_ITEMS) {
    fail('invalid_visual_index', `visual-index items должен содержать не более ${MAX_VISUAL_INDEX_ITEMS} позиций.`);
  }
  const items = value.items.map(normalizeItem);
  const paths = new Set();
  const digests = new Map();
  for (const item of items) {
    if (paths.has(item.path)) {
      fail('duplicate_visual_path', `Повторяющийся visual-index path: ${item.path}.`);
    }
    const digestOwner = digests.get(item.sha256);
    if (digestOwner) {
      fail('duplicate_image_content', `Изображение ${item.path} дублирует ${digestOwner}.`);
    }
    paths.add(item.path);
    digests.set(item.sha256, item.path);
  }
  return {
    schema_version: VISUAL_INDEX_SCHEMA_VERSION,
    catalog_version: value.catalog_version,
    items,
  };
}

function assertFingerprintMatchesDimensions(operation, fingerprint) {
  const width = operation?.width;
  const height = operation?.height;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    fail('invalid_visual_fingerprint', 'Размеры изображения для визуальной проверки отсутствуют.');
  }
  const expected = width / height;
  const delta = Math.abs(fingerprint.aspect_ratio - expected) / Math.max(fingerprint.aspect_ratio, expected);
  if (delta > 0.001) {
    fail('invalid_visual_fingerprint', 'Пропорции визуального отпечатка не совпадают с изображением.');
  }
}

export function buildVisualIndexUpdate(currentValue, nextCatalogVersion, operations) {
  const current = validateVisualIndex(currentValue);
  if (nextCatalogVersion !== current.catalog_version + 1) {
    fail('visual_index_version_conflict', 'Версия visual-index не совпадает с обновлением каталога.');
  }
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 20) {
    fail('invalid_visual_operations', 'Некорректная партия visual-index операций.');
  }

  const items = current.items.map((item) => ({ ...item, fingerprint: { ...item.fingerprint } }));
  const paths = new Set(items.map((item) => item.path));
  const digests = new Map(items.map((item) => [item.sha256, item.path]));

  for (const operation of operations) {
    if (operation?.mode === 'delete') {
      if (operation.purge_file === true) {
        const itemIndex = items.findIndex((item) => item.path === operation.path);
        if (itemIndex < 0) {
          fail('visual_index_missing_path', `Visual index не содержит ${operation.path}.`);
        }
        const [removed] = items.splice(itemIndex, 1);
        paths.delete(removed.path);
        digests.delete(removed.sha256);
      }
      continue;
    }

    if (!VERSIONED_LOGO_PATH.test(operation?.path || '') || paths.has(operation.path)) {
      fail('invalid_visual_path', `Некорректный или занятый visual-index path: ${operation?.path || ''}.`);
    }
    if (typeof operation.sha256 !== 'string' || !SHA256_PATTERN.test(operation.sha256)) {
      fail('invalid_visual_digest', `Некорректный SHA-256 для ${operation.path}.`);
    }
    const digestOwner = digests.get(operation.sha256);
    if (digestOwner) {
      fail('duplicate_image_content', `Изображение ${operation.path} дублирует ${digestOwner}.`);
    }
    let fingerprint;
    try {
      fingerprint = validateVisualFingerprint(operation.fingerprint);
    } catch {
      fail('invalid_visual_fingerprint', `Визуальный отпечаток ${operation.path} некорректен.`);
    }
    assertFingerprintMatchesDimensions(operation, fingerprint);
    const visualOwner = items.find((item) => visualFingerprintsMatch(item.fingerprint, fingerprint));
    if (visualOwner) {
      fail('duplicate_image_visual', `Изображение ${operation.path} визуально дублирует ${visualOwner.path}.`);
    }
    items.push({ path: operation.path, sha256: operation.sha256, fingerprint });
    paths.add(operation.path);
    digests.set(operation.sha256, operation.path);
  }

  if (items.length > MAX_VISUAL_INDEX_ITEMS) {
    fail('visual_index_too_large', `Visual index не может содержать более ${MAX_VISUAL_INDEX_ITEMS} позиций.`);
  }
  return validateVisualIndex({
    schema_version: VISUAL_INDEX_SCHEMA_VERSION,
    catalog_version: nextCatalogVersion,
    items,
  });
}

export function serializeVisualIndex(value) {
  const serialized = `${JSON.stringify(validateVisualIndex(value), null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_VISUAL_INDEX_BYTES) {
    fail('visual_index_too_large', 'visual-index.json превышает безопасный лимит GitHub Contents API.');
  }
  return serialized;
}
