export const AFFILIATE_CATALOG_SCHEMA_VERSION = 1;
export const MAX_AFFILIATE_CATALOG_ITEMS = 2000;
export const MAX_AFFILIATE_BATCH_ITEMS = 20;
export const MAX_AFFILIATE_CATALOG_BYTES = 900 * 1024;

const encoder = new TextEncoder();

const ITEM_KEYS = [
  'brand',
  'destination_url',
  'id',
  'tags',
  'version',
];

export class AffiliateCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AffiliateCatalogError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AffiliateCatalogError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, context) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail('invalid_keys', `${context}: набор полей не соответствует схеме.`);
  }
}

function normalizeDisplayText(value, field, maxLength, required = true) {
  if (typeof value !== 'string') {
    fail('invalid_text', `${field}: ожидается строка.`);
  }

  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (required && normalized === '') {
    fail('required_field', `${field}: поле обязательно.`);
  }
  if (normalized.length > maxLength) {
    fail('text_too_long', `${field}: максимум ${maxLength} символов.`);
  }

  return normalized;
}

function slugify(value, maxLength = 80) {
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  if (!slug) {
    fail('invalid_slug', 'Не удалось сформировать латинский идентификатор бренда.');
  }

  return slug;
}

function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const tags = [];

  for (const rawTag of values) {
    const tag = normalizeDisplayText(String(rawTag), 'Тег', 40, false).toLowerCase();
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  if (tags.length > 12) {
    fail('too_many_tags', 'Для одного бренда разрешено не более 12 тегов.');
  }

  return tags;
}

export function normalizeDestinationUrl(value) {
  if (typeof value !== 'string') {
    fail('invalid_destination_url', 'Affiliate URL должен быть строкой.');
  }

  const normalized = value.trim();
  if (
    normalized.length < 10
    || encoder.encode(normalized).byteLength > 4096
    || !/^https?:\/\//i.test(normalized)
    || /[\u0000-\u0020\u007f]/.test(normalized)
  ) {
    fail('invalid_destination_url', 'Укажите полный HTTP(S) affiliate URL без пробелов.');
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    fail('invalid_destination_url', 'Affiliate URL имеет некорректный формат.');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    fail('invalid_destination_url', 'Affiliate URL должен использовать HTTP(S) и не содержать логин или пароль.');
  }

  // Keep the manager-provided URL byte-for-byte apart from surrounding whitespace.
  // In particular, tracking query parameters must not be reconstructed or reordered.
  return normalized;
}

function normalizeCatalogItem(item, index) {
  if (!isPlainObject(item)) {
    fail('invalid_item', `Позиция ${index + 1}: ожидается объект.`);
  }

  assertExactKeys(item, ITEM_KEYS, `Позиция ${index + 1}`);
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(item.id)) {
    fail('invalid_id', `Позиция ${index + 1}: некорректный id.`);
  }

  const brand = normalizeDisplayText(item.brand, 'brand', 100);
  if (brand !== item.brand) {
    fail('non_normalized_text', `Позиция ${index + 1}: brand не нормализован.`);
  }

  if (!Number.isInteger(item.version) || item.version < 1) {
    fail('invalid_version', `Позиция ${index + 1}: version должен быть положительным целым.`);
  }

  const destinationUrl = normalizeDestinationUrl(item.destination_url);
  if (destinationUrl !== item.destination_url) {
    fail('non_normalized_url', `Позиция ${index + 1}: destination_url содержит внешние пробелы.`);
  }

  const tags = normalizeTags(item.tags);
  if (!Array.isArray(item.tags) || JSON.stringify(tags) !== JSON.stringify(item.tags)) {
    fail('invalid_tags', `Позиция ${index + 1}: tags должны быть уникальными нормализованными строками.`);
  }

  return {
    id: item.id,
    brand,
    destination_url: destinationUrl,
    version: item.version,
    tags,
  };
}

export function validateAffiliateCatalog(value) {
  if (!isPlainObject(value)) {
    fail('invalid_catalog', 'catalog.json должен содержать объект.');
  }

  assertExactKeys(value, ['schema_version', 'catalog_version', 'items'], 'catalog.json');
  if (value.schema_version !== AFFILIATE_CATALOG_SCHEMA_VERSION) {
    fail('unsupported_schema', `Поддерживается schema_version ${AFFILIATE_CATALOG_SCHEMA_VERSION}.`);
  }
  if (!Number.isInteger(value.catalog_version) || value.catalog_version < 1) {
    fail('invalid_catalog_version', 'catalog_version должен быть положительным целым.');
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_AFFILIATE_CATALOG_ITEMS) {
    fail('invalid_items', `items должен быть массивом максимум из ${MAX_AFFILIATE_CATALOG_ITEMS} позиций.`);
  }

  const items = value.items.map(normalizeCatalogItem);
  const ids = new Set();
  const brands = new Set();

  for (const item of items) {
    if (ids.has(item.id)) {
      fail('duplicate_id', `Повторяющийся id: ${item.id}.`);
    }
    const brandKey = item.brand.toLowerCase();
    if (brands.has(brandKey)) {
      fail('duplicate_brand', `Для бренда ${item.brand} уже существует affiliate URL.`);
    }
    ids.add(item.id);
    brands.add(brandKey);
  }

  const normalizedCatalog = {
    schema_version: AFFILIATE_CATALOG_SCHEMA_VERSION,
    catalog_version: value.catalog_version,
    items,
  };
  const serializedBytes = encoder.encode(`${JSON.stringify(normalizedCatalog, null, 2)}\n`).byteLength;
  if (serializedBytes > MAX_AFFILIATE_CATALOG_BYTES) {
    fail('catalog_too_large', 'Affiliate catalog превышает безопасный лимит GitHub Contents API.');
  }

  return normalizedCatalog;
}

function sameItemContent(left, right) {
  return left.brand === right.brand
    && left.destination_url === right.destination_url
    && JSON.stringify(left.tags) === JSON.stringify(right.tags);
}

export function validateAffiliateCatalogTransition(baseValue, candidateValue, options = {}) {
  const base = validateAffiliateCatalog(baseValue);
  const candidate = validateAffiliateCatalog(candidateValue);
  const changed = JSON.stringify(candidate) !== JSON.stringify(base);
  const expectedCatalogVersion = changed
    ? base.catalog_version + 1
    : base.catalog_version;

  if (candidate.catalog_version !== expectedCatalogVersion) {
    fail(
      'catalog_version_transition',
      `catalog_version должен быть ${expectedCatalogVersion} для этого изменения.`,
    );
  }

  const baseItems = new Map(base.items.map((item) => [item.id, item]));
  for (const item of candidate.items) {
    const previous = baseItems.get(item.id);
    if (!previous) {
      if (item.version !== 1) {
        fail('new_item_version', `Новая позиция ${item.id} должна начинаться с version 1.`);
      }
      continue;
    }

    const expectedVersion = sameItemContent(item, previous)
      ? previous.version
      : previous.version + 1;
    if (item.version !== expectedVersion) {
      fail('item_version_transition', `Позиция ${item.id} должна иметь version ${expectedVersion}.`);
    }
  }

  if (options.requireChange === true && !changed) {
    fail('catalog_change_missing', 'Предложение не содержит изменения affiliate-каталога.');
  }

  return { base, candidate, changed };
}

export function buildAffiliateCatalogUpdate(currentCatalog, entries) {
  const catalog = validateAffiliateCatalog(currentCatalog);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_AFFILIATE_BATCH_ITEMS) {
    fail('invalid_batch', `За один раз разрешено от 1 до ${MAX_AFFILIATE_BATCH_ITEMS} операций.`);
  }

  const items = catalog.items.map((item) => ({ ...item, tags: [...item.tags] }));
  const touchedIds = new Set();
  const changes = [];

  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      fail('invalid_entry', `Операция ${index + 1}: отсутствуют параметры.`);
    }

    const mode = ['new', 'update', 'delete'].includes(entry.mode) ? entry.mode : null;
    if (!mode) {
      fail('invalid_mode', `Операция ${index + 1}: неизвестное действие.`);
    }

    if (mode === 'delete') {
      if (typeof entry.asset_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.asset_id)) {
        fail('invalid_asset_id', `Операция ${index + 1}: выберите бренд для удаления.`);
      }
      const itemIndex = items.findIndex((item) => item.id === entry.asset_id);
      if (itemIndex < 0) {
        fail('unknown_asset', `Позиция ${entry.asset_id} не найдена в актуальном каталоге.`);
      }
      if (touchedIds.has(entry.asset_id)) {
        fail('duplicate_batch_item', `Позиция ${entry.asset_id} указана несколько раз.`);
      }
      touchedIds.add(entry.asset_id);
      const [removed] = items.splice(itemIndex, 1);
      changes.push({ mode, id: removed.id, brand: removed.brand, version: removed.version });
      return;
    }

    const brand = normalizeDisplayText(entry.brand, 'Бренд', 100);
    const destinationUrl = normalizeDestinationUrl(entry.destination_url);
    const tags = normalizeTags(entry.tags);
    let id;
    let version;
    let itemIndex = -1;

    if (mode === 'new') {
      id = slugify(brand);
      version = 1;
      if (items.some((item) => item.id === id)) {
        fail('duplicate_id', `Позиция ${id} уже существует. Выберите редактирование.`);
      }
    } else {
      if (typeof entry.asset_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.asset_id)) {
        fail('invalid_asset_id', `Операция ${index + 1}: выберите бренд для редактирования.`);
      }
      id = entry.asset_id;
      itemIndex = items.findIndex((item) => item.id === id);
      if (itemIndex < 0) {
        fail('unknown_asset', `Позиция ${id} не найдена в актуальном каталоге.`);
      }
      version = items[itemIndex].version + 1;
    }

    if (touchedIds.has(id)) {
      fail('duplicate_batch_item', `Позиция ${id} указана несколько раз.`);
    }
    touchedIds.add(id);

    const item = {
      id,
      brand,
      destination_url: destinationUrl,
      version,
      tags,
    };
    if (mode === 'new') {
      items.push(item);
    } else {
      items[itemIndex] = item;
    }
    changes.push({ mode, id, brand, version });
  });

  return {
    catalog: validateAffiliateCatalog({
      schema_version: AFFILIATE_CATALOG_SCHEMA_VERSION,
      catalog_version: catalog.catalog_version + 1,
      items,
    }),
    changes,
  };
}

export function serializeAffiliateCatalog(catalog) {
  return `${JSON.stringify(validateAffiliateCatalog(catalog), null, 2)}\n`;
}
