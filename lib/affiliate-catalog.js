export const AFFILIATE_CATALOG_SCHEMA_VERSION = 2;
export const AFFILIATE_LEGACY_SCHEMA_VERSION = 1;
export const MAX_AFFILIATE_CATALOG_ITEMS = 2000;
export const MAX_AFFILIATE_LINKS_PER_BRAND = 50;
export const MAX_AFFILIATE_CATALOG_LINKS = 5000;
export const MAX_AFFILIATE_BATCH_ITEMS = 20;
export const MAX_AFFILIATE_CATALOG_BYTES = 900 * 1024;

const encoder = new TextEncoder();
const BRAND_ITEM_KEYS = ['brand', 'id', 'links', 'logo_id', 'tags', 'version'];
const LINK_KEYS = ['destination_url', 'geo', 'id', 'label'];
const ROOT_KEYS = ['catalog_version', 'items', 'schema_version'];
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const GEO_PATTERN = /^(?:[A-Z]{2}|GLOBAL)$/;

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

export function affiliateBrandKey(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
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

function normalizeLogoId(value) {
  if (typeof value !== 'string') {
    fail('invalid_logo_id', 'logo_id должен быть строкой.');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== '' && !ID_PATTERN.test(normalized)) {
    fail('invalid_logo_id', 'Выбран некорректный логотип.');
  }
  return normalized;
}

function normalizeGeo(value) {
  const normalized = normalizeDisplayText(value, 'GEO', 6).toUpperCase();
  if (!GEO_PATTERN.test(normalized)) {
    fail('invalid_geo', 'GEO должен быть ISO-кодом из двух букв или GLOBAL.');
  }
  return normalized;
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

  // Preserve tracking paths and query parameters byte-for-byte after trimming.
  return normalized;
}

function destinationKey(value) {
  return new URL(normalizeDestinationUrl(value)).href;
}

function compareById(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function normalizeCatalogLink(link, itemIndex, linkIndex) {
  const context = `Позиция ${itemIndex + 1}, ссылка ${linkIndex + 1}`;
  if (!isPlainObject(link)) {
    fail('invalid_link', `${context}: ожидается объект.`);
  }
  assertExactKeys(link, LINK_KEYS, context);
  if (typeof link.id !== 'string' || !ID_PATTERN.test(link.id)) {
    fail('invalid_link_id', `${context}: некорректный id.`);
  }

  const geo = normalizeGeo(link.geo);
  if (geo !== link.geo) {
    fail('non_normalized_geo', `${context}: GEO не нормализован.`);
  }
  const label = normalizeDisplayText(link.label, 'label', 60, false);
  if (label !== link.label) {
    fail('non_normalized_text', `${context}: label не нормализован.`);
  }
  const destinationUrl = normalizeDestinationUrl(link.destination_url);
  if (destinationUrl !== link.destination_url) {
    fail('non_normalized_url', `${context}: destination_url содержит внешние пробелы.`);
  }

  return {
    id: link.id,
    geo,
    label,
    destination_url: destinationUrl,
  };
}

function normalizeCatalogItem(item, index) {
  if (!isPlainObject(item)) {
    fail('invalid_item', `Позиция ${index + 1}: ожидается объект.`);
  }

  assertExactKeys(item, BRAND_ITEM_KEYS, `Позиция ${index + 1}`);
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
    fail('invalid_id', `Позиция ${index + 1}: некорректный id.`);
  }

  const brand = normalizeDisplayText(item.brand, 'brand', 100);
  if (brand !== item.brand) {
    fail('non_normalized_text', `Позиция ${index + 1}: brand не нормализован.`);
  }
  const logoId = normalizeLogoId(item.logo_id);
  if (logoId !== item.logo_id) {
    fail('non_normalized_logo_id', `Позиция ${index + 1}: logo_id не нормализован.`);
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    fail('invalid_version', `Позиция ${index + 1}: version должен быть положительным целым.`);
  }

  const tags = normalizeTags(item.tags);
  if (!Array.isArray(item.tags) || JSON.stringify(tags) !== JSON.stringify(item.tags)) {
    fail('invalid_tags', `Позиция ${index + 1}: tags должны быть уникальными нормализованными строками.`);
  }
  if (!Array.isArray(item.links) || item.links.length < 1 || item.links.length > MAX_AFFILIATE_LINKS_PER_BRAND) {
    fail('invalid_links', `Позиция ${index + 1}: links должен содержать от 1 до ${MAX_AFFILIATE_LINKS_PER_BRAND} ссылок.`);
  }

  const links = item.links.map((link, linkIndex) => normalizeCatalogLink(link, index, linkIndex));
  const linkIds = new Set();
  const geoDestinations = new Set();
  for (const link of links) {
    if (linkIds.has(link.id)) {
      fail('duplicate_link_id', `Позиция ${item.id}: повторяющийся link id ${link.id}.`);
    }
    const scopedDestination = `${link.geo}\n${destinationKey(link.destination_url)}`;
    if (geoDestinations.has(scopedDestination)) {
      fail('duplicate_geo_destination', `Позиция ${item.id}: одинаковая ссылка уже существует для GEO ${link.geo}.`);
    }
    linkIds.add(link.id);
    geoDestinations.add(scopedDestination);
  }

  return {
    id: item.id,
    brand,
    logo_id: logoId,
    version: item.version,
    tags,
    links: links.sort(compareById),
  };
}

function validateCatalogRoot(value) {
  if (!isPlainObject(value)) {
    fail('invalid_catalog', 'catalog.json должен содержать объект.');
  }
  assertExactKeys(value, ROOT_KEYS, 'catalog.json');
  if (!Number.isInteger(value.catalog_version) || value.catalog_version < 1) {
    fail('invalid_catalog_version', 'catalog_version должен быть положительным целым.');
  }
}

export function validateAffiliateCatalog(value) {
  validateCatalogRoot(value);
  if (value.schema_version !== AFFILIATE_CATALOG_SCHEMA_VERSION) {
    fail('unsupported_schema', `Поддерживается schema_version ${AFFILIATE_CATALOG_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_AFFILIATE_CATALOG_ITEMS) {
    fail('invalid_items', `items должен быть массивом максимум из ${MAX_AFFILIATE_CATALOG_ITEMS} брендов.`);
  }

  const items = value.items.map(normalizeCatalogItem);
  const ids = new Set();
  const brands = new Set();
  const destinationOwners = new Map();
  let linkCount = 0;

  for (const item of items) {
    if (ids.has(item.id)) {
      fail('duplicate_id', `Повторяющийся id: ${item.id}.`);
    }
    const normalizedBrand = affiliateBrandKey(item.brand);
    if (!normalizedBrand || brands.has(normalizedBrand)) {
      fail('duplicate_brand', `Для бренда ${item.brand} уже существует позиция каталога.`);
    }
    ids.add(item.id);
    brands.add(normalizedBrand);

    for (const link of item.links) {
      linkCount += 1;
      const normalizedDestination = destinationKey(link.destination_url);
      const previousOwner = destinationOwners.get(normalizedDestination);
      if (previousOwner && previousOwner !== item.id) {
        fail('duplicate_destination_brand', `Одинаковый affiliate URL назначен разным брендам: ${previousOwner} и ${item.id}.`);
      }
      destinationOwners.set(normalizedDestination, item.id);
    }
  }

  if (linkCount > MAX_AFFILIATE_CATALOG_LINKS) {
    fail('too_many_links', `Каталог содержит больше ${MAX_AFFILIATE_CATALOG_LINKS} ссылок.`);
  }

  const normalizedCatalog = {
    schema_version: AFFILIATE_CATALOG_SCHEMA_VERSION,
    catalog_version: value.catalog_version,
    items: items.sort(compareById),
  };
  const serializedBytes = encoder.encode(`${JSON.stringify(normalizedCatalog, null, 2)}\n`).byteLength;
  if (serializedBytes > MAX_AFFILIATE_CATALOG_BYTES) {
    fail('catalog_too_large', 'Affiliate catalog превышает безопасный лимит GitHub Contents API.');
  }

  return normalizedCatalog;
}

export function validateAffiliateCatalogSnapshot(value) {
  validateCatalogRoot(value);
  if (value.schema_version === AFFILIATE_LEGACY_SCHEMA_VERSION) {
    if (!Array.isArray(value.items) || value.items.length !== 0) {
      fail('legacy_catalog_not_empty', 'Автоматически поддерживается только пустой legacy schema v1 каталог.');
    }
    return {
      catalog: {
        schema_version: AFFILIATE_CATALOG_SCHEMA_VERSION,
        catalog_version: value.catalog_version,
        items: [],
      },
      source_schema_version: AFFILIATE_LEGACY_SCHEMA_VERSION,
    };
  }

  return {
    catalog: validateAffiliateCatalog(value),
    source_schema_version: AFFILIATE_CATALOG_SCHEMA_VERSION,
  };
}

export function serializeAffiliateCatalogSnapshot(value) {
  const snapshot = validateAffiliateCatalogSnapshot(value);
  if (snapshot.source_schema_version === AFFILIATE_LEGACY_SCHEMA_VERSION) {
    return `${JSON.stringify({
      schema_version: AFFILIATE_LEGACY_SCHEMA_VERSION,
      catalog_version: snapshot.catalog.catalog_version,
      items: [],
    }, null, 2)}\n`;
  }
  return `${JSON.stringify(snapshot.catalog, null, 2)}\n`;
}

function sameItemContent(left, right) {
  return left.brand === right.brand
    && left.logo_id === right.logo_id
    && JSON.stringify(left.tags) === JSON.stringify(right.tags)
    && JSON.stringify(left.links) === JSON.stringify(right.links);
}

export function validateAffiliateCatalogTransition(baseValue, candidateValue, options = {}) {
  const baseSnapshot = validateAffiliateCatalogSnapshot(baseValue);
  const candidateSnapshot = validateAffiliateCatalogSnapshot(candidateValue);
  const base = baseSnapshot.catalog;
  const candidate = candidateSnapshot.catalog;
  const changed = JSON.stringify(candidate.items) !== JSON.stringify(base.items);
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

  return {
    base,
    candidate,
    changed,
    base_source_schema_version: baseSnapshot.source_schema_version,
    candidate_source_schema_version: candidateSnapshot.source_schema_version,
  };
}

function nextLinkId(geo, label, usedIds) {
  const geoId = geo.toLowerCase();
  const labelId = label ? slugify(label, 48) : '';
  const base = `${geoId}${labelId ? `-${labelId}` : ''}`.slice(0, 72).replace(/-+$/g, '');
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 80 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeMutationLinks(value, previousLinks, context) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AFFILIATE_LINKS_PER_BRAND) {
    fail('invalid_links', `${context}: добавьте от 1 до ${MAX_AFFILIATE_LINKS_PER_BRAND} ссылок.`);
  }

  const previousIds = new Set(previousLinks.map((link) => link.id));
  const reservedIds = new Set();
  value.forEach((rawLink, index) => {
    const id = isPlainObject(rawLink) && typeof rawLink.id === 'string'
      ? rawLink.id.trim().toLowerCase()
      : '';
    if (!id) return;
    if (!ID_PATTERN.test(id) || !previousIds.has(id)) {
      fail('invalid_link_id', `${context}, ссылка ${index + 1}: существующий link id некорректен.`);
    }
    if (reservedIds.has(id)) {
      fail('duplicate_link_id', `${context}: link id ${id} указан несколько раз.`);
    }
    reservedIds.add(id);
  });
  const usedIds = new Set(reservedIds);
  const links = value.map((rawLink, index) => {
    if (!isPlainObject(rawLink)) {
      fail('invalid_link', `${context}, ссылка ${index + 1}: ожидается объект.`);
    }
    assertExactKeys(rawLink, LINK_KEYS, `${context}, ссылка ${index + 1}`);

    const geo = normalizeGeo(rawLink.geo);
    const label = normalizeDisplayText(rawLink.label, 'label', 60, false);
    const destinationUrl = normalizeDestinationUrl(rawLink.destination_url);
    let id = typeof rawLink.id === 'string' ? rawLink.id.trim().toLowerCase() : '';
    if (!id) {
      id = nextLinkId(geo, label, usedIds);
      usedIds.add(id);
    }
    return { id, geo, label, destination_url: destinationUrl };
  });

  return links.sort(compareById);
}

export function buildAffiliateCatalogUpdate(currentCatalog, entries) {
  const catalog = validateAffiliateCatalog(currentCatalog);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_AFFILIATE_BATCH_ITEMS) {
    fail('invalid_batch', `За один раз разрешено от 1 до ${MAX_AFFILIATE_BATCH_ITEMS} операций.`);
  }

  const items = catalog.items.map((item) => ({
    ...item,
    tags: [...item.tags],
    links: item.links.map((link) => ({ ...link })),
  }));
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
      if (typeof entry.asset_id !== 'string' || !ID_PATTERN.test(entry.asset_id)) {
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
      changes.push({ mode, id: removed.id, brand: removed.brand, version: removed.version, links: removed.links.length });
      return;
    }

    const brand = normalizeDisplayText(entry.brand, 'Бренд', 100);
    const logoId = normalizeLogoId(String(entry.logo_id || ''));
    const tags = normalizeTags(entry.tags);
    let id;
    let version;
    let itemIndex = -1;
    let previousLinks = [];

    if (mode === 'new') {
      id = slugify(brand);
      version = 1;
      if (items.some((item) => item.id === id)) {
        fail('duplicate_id', `Позиция ${id} уже существует. Выберите редактирование.`);
      }
    } else {
      if (typeof entry.asset_id !== 'string' || !ID_PATTERN.test(entry.asset_id)) {
        fail('invalid_asset_id', `Операция ${index + 1}: выберите бренд для редактирования.`);
      }
      id = entry.asset_id;
      itemIndex = items.findIndex((item) => item.id === id);
      if (itemIndex < 0) {
        fail('unknown_asset', `Позиция ${id} не найдена в актуальном каталоге.`);
      }
      previousLinks = items[itemIndex].links;
      version = items[itemIndex].version + 1;
    }

    if (touchedIds.has(id)) {
      fail('duplicate_batch_item', `Позиция ${id} указана несколько раз.`);
    }
    touchedIds.add(id);

    const links = normalizeMutationLinks(entry.links, previousLinks, `Операция ${index + 1}`);
    const item = { id, brand, logo_id: logoId, version, tags, links };
    if (mode === 'new') {
      items.push(item);
    } else {
      if (sameItemContent(item, items[itemIndex])) {
        fail('item_change_missing', `Позиция ${id} не содержит изменений.`);
      }
      items[itemIndex] = item;
    }
    changes.push({ mode, id, brand, version, links: links.length });
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
