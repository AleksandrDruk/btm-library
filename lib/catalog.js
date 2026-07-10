export const CATALOG_SCHEMA_VERSION = 1;
export const MAX_CATALOG_ITEMS = 1000;
export const MAX_BATCH_ITEMS = 20;

const ITEM_KEYS = [
  'brand',
  'id',
  'path',
  'suggested_filename',
  'tags',
  'variant',
  'version',
];

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatalogError(code, message);
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

export function normalizeDisplayText(value, field, maxLength, required = true) {
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

export function slugify(value, maxLength = 80) {
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
    fail('invalid_slug', 'Не удалось сформировать латинский идентификатор.');
  }

  return slug;
}

function normalizeExtension(value) {
  const extension = String(value).toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) {
    fail('invalid_extension', 'Поддерживаются только JPEG, PNG и WebP.');
  }
  return extension === 'jpeg' ? 'jpg' : extension;
}

export function normalizeSuggestedFilename(value, fallback, extension) {
  const normalizedExtension = normalizeExtension(extension);
  const raw = normalizeDisplayText(value || fallback, 'Имя файла', 100);

  if (raw.includes('/') || raw.includes('\\')) {
    fail('invalid_filename', 'Имя файла не должно содержать путь.');
  }

  const withoutExtension = raw.replace(/\.(?:jpe?g|png|webp)$/i, '');
  const basename = slugify(withoutExtension, 80);
  return `${basename}.${normalizedExtension}`;
}

export function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const tags = [];

  for (const rawTag of values) {
    const tag = normalizeDisplayText(String(rawTag), 'Тег', 40, false).toLowerCase();
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  if (tags.length > 12) {
    fail('too_many_tags', 'Для одного логотипа разрешено не более 12 тегов.');
  }

  return tags;
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
  const variant = normalizeDisplayText(item.variant, 'variant', 60, false);
  if (brand !== item.brand || variant !== item.variant) {
    fail('non_normalized_text', `Позиция ${index + 1}: текстовые поля не нормализованы.`);
  }

  if (!Number.isInteger(item.version) || item.version < 1) {
    fail('invalid_version', `Позиция ${index + 1}: version должен быть положительным целым.`);
  }

  if (typeof item.path !== 'string' || item.path.includes('..') || item.path.includes('\\')) {
    fail('invalid_path', `Позиция ${index + 1}: некорректный path.`);
  }

  const pathMatch = item.path.match(/^logos\/([a-z0-9][a-z0-9-]{0,79})\/([a-z0-9][a-z0-9_-]{0,79})-v([1-9][0-9]*)\.(jpg|png|webp)$/);
  if (!pathMatch) {
    fail('invalid_path', `Позиция ${index + 1}: path не соответствует versioned-схеме.`);
  }

  if (pathMatch[1] !== slugify(brand) || pathMatch[2] !== item.id || Number(pathMatch[3]) !== item.version) {
    fail('path_mismatch', `Позиция ${index + 1}: path не совпадает с brand, id или version.`);
  }

  const suggestedPattern = /^[a-z0-9][a-z0-9_-]{0,79}\.(jpg|png|webp)$/;
  const suggestedMatch = typeof item.suggested_filename === 'string'
    ? item.suggested_filename.match(suggestedPattern)
    : null;
  if (!suggestedMatch || suggestedMatch[1] !== pathMatch[4]) {
    fail('invalid_suggested_filename', `Позиция ${index + 1}: некорректное suggested_filename.`);
  }

  const tags = normalizeTags(item.tags);
  if (!Array.isArray(item.tags) || JSON.stringify(tags) !== JSON.stringify(item.tags)) {
    fail('invalid_tags', `Позиция ${index + 1}: tags должны быть уникальными нормализованными строками.`);
  }

  return {
    id: item.id,
    brand,
    variant,
    path: item.path,
    suggested_filename: item.suggested_filename,
    version: item.version,
    tags,
  };
}

export function validateCatalog(value) {
  if (!isPlainObject(value)) {
    fail('invalid_catalog', 'catalog.json должен содержать объект.');
  }

  assertExactKeys(value, ['schema_version', 'catalog_version', 'items'], 'catalog.json');

  if (value.schema_version !== CATALOG_SCHEMA_VERSION) {
    fail('unsupported_schema', `Поддерживается schema_version ${CATALOG_SCHEMA_VERSION}.`);
  }

  if (!Number.isInteger(value.catalog_version) || value.catalog_version < 1) {
    fail('invalid_catalog_version', 'catalog_version должен быть положительным целым.');
  }

  if (!Array.isArray(value.items) || value.items.length > MAX_CATALOG_ITEMS) {
    fail('invalid_items', `items должен быть массивом максимум из ${MAX_CATALOG_ITEMS} позиций.`);
  }

  const items = value.items.map(normalizeCatalogItem);
  const ids = new Set();
  const paths = new Set();
  const brandVariants = new Set();

  for (const item of items) {
    if (ids.has(item.id)) {
      fail('duplicate_id', `Повторяющийся id: ${item.id}.`);
    }
    if (paths.has(item.path)) {
      fail('duplicate_path', `Повторяющийся path: ${item.path}.`);
    }
    const brandVariant = `${item.brand.toLowerCase()}\u0000${item.variant.toLowerCase()}`;
    if (brandVariants.has(brandVariant)) {
      fail('duplicate_brand_variant', `Для ${item.brand} уже существует вариант ${item.variant || 'Primary'}.`);
    }
    ids.add(item.id);
    paths.add(item.path);
    brandVariants.add(brandVariant);
  }

  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    catalog_version: value.catalog_version,
    items,
  };
}

export function buildCatalogUpdate(currentCatalog, entries) {
  const catalog = validateCatalog(currentCatalog);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_BATCH_ITEMS) {
    fail('invalid_batch', `За один раз можно загрузить от 1 до ${MAX_BATCH_ITEMS} изображений.`);
  }

  const items = catalog.items.map((item) => ({ ...item, tags: [...item.tags] }));
  const usedIds = new Set(items.map((item) => item.id));
  const usedPaths = new Set(items.map((item) => item.path));
  const touchedIds = new Set();
  const changes = [];

  entries.forEach((entry, fileIndex) => {
    if (!isPlainObject(entry)) {
      fail('invalid_entry', `Файл ${fileIndex + 1}: отсутствуют параметры.`);
    }

    const mode = ['new', 'update', 'delete'].includes(entry.mode) ? entry.mode : null;
    if (!mode) {
      fail('invalid_mode', `Файл ${fileIndex + 1}: неизвестное действие.`);
    }

    if (mode === 'delete') {
      if (typeof entry.asset_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.asset_id)) {
        fail('invalid_asset_id', `Удаление ${fileIndex + 1}: выберите позицию каталога.`);
      }
      const itemIndex = items.findIndex((item) => item.id === entry.asset_id);
      if (itemIndex < 0) {
        fail('unknown_asset', `Позиция ${entry.asset_id} не найдена в актуальном каталоге.`);
      }
      if (touchedIds.has(entry.asset_id)) {
        fail('duplicate_batch_item', `Позиция ${entry.asset_id} указана в партии несколько раз.`);
      }
      touchedIds.add(entry.asset_id);
      const [removed] = items.splice(itemIndex, 1);
      usedIds.delete(removed.id);
      changes.push({
        file_index: null,
        mode,
        id: removed.id,
        path: removed.path,
        version: removed.version,
        brand: removed.brand,
        purge_file: entry.purge_file === true,
      });
      return;
    }

    if (!isPlainObject(entry.image)) {
      fail('invalid_entry', `Файл ${fileIndex + 1}: отсутствуют параметры изображения.`);
    }

    const brand = normalizeDisplayText(entry.brand, 'Бренд', 100);
    const variant = normalizeDisplayText(entry.variant || 'Primary', 'Вариант', 60, false) || 'Primary';
    const extension = normalizeExtension(entry.image.extension);
    const tags = normalizeTags(entry.tags);
    let id;
    let version;
    let itemIndex = -1;

    if (mode === 'new') {
      id = slugify(`${brand}-${variant || 'primary'}`);
      version = 1;
      if (usedIds.has(id)) {
        fail('duplicate_id', `Позиция ${id} уже существует. Выберите обновление версии.`);
      }
    } else {
      if (typeof entry.asset_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.asset_id)) {
        fail('invalid_asset_id', `Файл ${fileIndex + 1}: выберите позицию для обновления.`);
      }
      id = entry.asset_id;
      itemIndex = items.findIndex((item) => item.id === id);
      if (itemIndex < 0) {
        fail('unknown_asset', `Позиция ${id} не найдена в актуальном каталоге.`);
      }
      version = items[itemIndex].version + 1;
    }

    if (touchedIds.has(id)) {
      fail('duplicate_batch_item', `Позиция ${id} указана в партии несколько раз.`);
    }
    touchedIds.add(id);

    const directory = slugify(brand);
    const path = `logos/${directory}/${id}-v${version}.${extension}`;
    if (usedPaths.has(path)) {
      fail('duplicate_path', `Файл ${path} уже существует.`);
    }

    const item = {
      id,
      brand,
      variant,
      path,
      suggested_filename: normalizeSuggestedFilename(entry.suggested_filename, id, extension),
      version,
      tags,
    };

    if (mode === 'new') {
      items.push(item);
      usedIds.add(id);
    } else {
      items[itemIndex] = item;
    }
    usedPaths.add(path);

    changes.push({
      file_index: fileIndex,
      mode,
      id,
      path,
      version,
      brand,
    });
  });

  return {
    catalog: validateCatalog({
      schema_version: CATALOG_SCHEMA_VERSION,
      catalog_version: catalog.catalog_version + 1,
      items,
    }),
    changes,
  };
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(validateCatalog(catalog), null, 2)}\n`;
}
