#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateCatalog } from '../lib/catalog.js';
import { inspectImage } from '../lib/image.js';
import {
  MAX_VISUAL_INDEX_BYTES,
  validateVisualIndex,
  VISUAL_INDEX_PATH,
} from '../lib/visual-index.js';
import { visualFingerprintsMatch } from '../lib/visual-dedupe.js';

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_LOGO_FILES = 5000;
const MAX_LOGO_BYTES = 200 * 1024 * 1024;
const VERSIONED_LOGO_PATH = /^logos\/[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9_-]{0,79}-v[1-9][0-9]*\.(?:jpg|png|webp)$/;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readCatalog(root) {
  const file = path.join(root, 'catalog.json');
  const stats = await lstat(file);
  invariant(stats.isFile() && !stats.isSymbolicLink(), 'catalog.json должен быть обычным файлом.');
  invariant(stats.size > 0 && stats.size <= MAX_CATALOG_BYTES, 'catalog.json превышает лимит 1 МиБ.');
  const raw = await readFile(file, 'utf8');
  return validateCatalog(JSON.parse(raw));
}

async function readVisualIndex(root, required = true) {
  const file = path.join(root, VISUAL_INDEX_PATH);
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw error;
  }
  invariant(stats.isFile() && !stats.isSymbolicLink(), `${VISUAL_INDEX_PATH} должен быть обычным файлом.`);
  invariant(
    stats.size > 0 && stats.size <= MAX_VISUAL_INDEX_BYTES,
    `${VISUAL_INDEX_PATH} превышает лимит 900 КиБ.`,
  );
  return validateVisualIndex(JSON.parse(await readFile(file, 'utf8')));
}

async function collectLogoFiles(root, relative = 'logos', state = { count: 0, directories: 0, bytes: 0 }) {
  const absolute = path.join(root, relative);
  const directoryStats = await lstat(absolute);
  invariant(directoryStats.isDirectory() && !directoryStats.isSymbolicLink(), `${relative} должен быть обычной директорией.`);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = new Map();

  for (const entry of entries) {
    const childRelative = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    const childAbsolute = path.join(root, childRelative);
    const stats = await lstat(childAbsolute);
    invariant(!stats.isSymbolicLink(), `Symlink запрещён: ${childRelative}`);
    if (stats.isDirectory()) {
      invariant(relative === 'logos', `Вложенные директории в logos запрещены: ${childRelative}`);
      invariant(/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.name), `Некорректная директория в logos: ${childRelative}`);
      state.directories += 1;
      invariant(state.directories <= 1000, 'В logos разрешено максимум 1000 директорий брендов.');
      const nested = await collectLogoFiles(root, childRelative, state);
      for (const [name, value] of nested) files.set(name, value);
    } else if (stats.isFile()) {
      if (childRelative === 'logos/.gitkeep') continue;
      invariant(VERSIONED_LOGO_PATH.test(childRelative), `Некорректный versioned path: ${childRelative}`);
      state.count += 1;
      state.bytes += stats.size;
      invariant(state.count <= MAX_LOGO_FILES, `В logos разрешено максимум ${MAX_LOGO_FILES} файлов.`);
      invariant(stats.size > 0 && stats.size <= 10 * 1024 * 1024, `Некорректный размер файла: ${childRelative}`);
      invariant(state.bytes <= MAX_LOGO_BYTES, 'Общий размер logos превышает 200 МиБ.');
      files.set(childRelative, await readFile(childAbsolute));
    } else {
      throw new Error(`Неподдерживаемый тип файла: ${childRelative}`);
    }
  }
  return files;
}

function extensionForMime(mime) {
  return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateLogoFiles(catalog, visualIndex, files) {
  const visualItems = visualIndex
    ? new Map(visualIndex.items.map((item) => [item.path, item]))
    : null;
  if (visualIndex) {
    invariant(
      visualIndex.catalog_version === catalog.catalog_version,
      'catalog_version в catalog.json и visual-index.json должен совпадать.',
    );
    invariant(visualIndex.items.length === files.size, 'Visual index должен описывать каждый versioned logo file.');
  }
  const catalogPaths = new Set(catalog.items.map((item) => item.path));
  for (const item of catalog.items) {
    invariant(files.has(item.path), `Файл из catalog.json отсутствует: ${item.path}`);
    if (item.sha256) {
      invariant(sha256Hex(files.get(item.path)) === item.sha256, `SHA-256 не совпадает: ${item.path}`);
    }
  }

  for (const [filePath, bytes] of files) {
    if (!filePath.startsWith('logos/')) continue;
    if (filePath === 'logos/.gitkeep') continue;
    invariant(/\.(?:jpg|png|webp)$/.test(filePath), `В logos запрещён тип файла: ${filePath}`);
    const image = inspectImage(bytes);
    const extension = filePath.split('.').pop();
    invariant(extension === extensionForMime(image.mime), `MIME не совпадает с расширением: ${filePath}`);
    if (visualItems) {
      const visualItem = visualItems.get(filePath);
      invariant(visualItem, `Visual index не содержит ${filePath}.`);
      invariant(visualItem.sha256 === sha256Hex(bytes), `Visual index SHA-256 не совпадает: ${filePath}`);
    }

    if (!catalogPaths.has(filePath)) {
      // Unlisted versioned files are valid immutable history.
      invariant(VERSIONED_LOGO_PATH.test(filePath), `Неописанный файл не является versioned history: ${filePath}`);
    }
  }
}

function validateVisualIndexBootstrap(index) {
  for (let left = 0; left < index.items.length; left += 1) {
    for (let right = left + 1; right < index.items.length; right += 1) {
      invariant(
        !visualFingerprintsMatch(index.items[left].fingerprint, index.items[right].fingerprint),
        `Изображение ${index.items[right].path} визуально дублирует ${index.items[left].path}.`,
      );
    }
  }
}

function visualItemMap(index) {
  return new Map(index.items.map((item) => [item.path, item]));
}

function validateVisualIndexTransition(baseIndex, candidateIndex, baseFiles, candidateFiles, catalogChanged) {
  if (!catalogChanged) {
    invariant(equalJson(baseIndex, candidateIndex), 'Каталог не менялся, но visual-index.json изменён.');
    return;
  }
  invariant(
    candidateIndex.catalog_version === baseIndex.catalog_version + 1,
    'visual-index catalog_version должна увеличиться ровно на 1.',
  );
  const baseItems = visualItemMap(baseIndex);
  const candidateItems = visualItemMap(candidateIndex);
  for (const [filePath, baseItem] of baseItems) {
    const candidateItem = candidateItems.get(filePath);
    if (!candidateFiles.has(filePath)) {
      invariant(!candidateItem, `Visual index сохранил удалённый файл: ${filePath}`);
      continue;
    }
    invariant(candidateItem && equalJson(baseItem, candidateItem), `Visual fingerprint изменён: ${filePath}`);
  }

  const accepted = [...baseItems.values()].filter((item) => candidateFiles.has(item.path));
  for (const candidateItem of candidateIndex.items) {
    if (baseItems.has(candidateItem.path)) continue;
    invariant(!baseFiles.has(candidateItem.path), `Visual index неожиданно добавил старый файл: ${candidateItem.path}`);
    const duplicate = accepted.find((item) => (
      visualFingerprintsMatch(item.fingerprint, candidateItem.fingerprint)
    ));
    invariant(!duplicate, `Изображение ${candidateItem.path} визуально дублирует ${duplicate?.path}.`);
    accepted.push(candidateItem);
  }
}

function withoutDigest(item) {
  const { sha256, ...legacy } = item;
  return legacy;
}

function validateSchemaMigration(baseCatalog, candidateCatalog, baseFiles, candidateFiles) {
  invariant(
    baseCatalog.schema_version === 1 && candidateCatalog.schema_version === 2,
    'Разрешён только переход logo catalog schema 1 → 2.',
  );
  invariant(
    candidateCatalog.catalog_version === baseCatalog.catalog_version + 1,
    'При schema migration catalog_version должна увеличиться ровно на 1.',
  );
  invariant(candidateCatalog.items.length === baseCatalog.items.length, 'Schema migration не должна менять состав каталога.');

  const candidateItems = itemMap(candidateCatalog);
  for (const baseItem of baseCatalog.items) {
    const candidateItem = candidateItems.get(baseItem.id);
    invariant(candidateItem, `Schema migration потеряла позицию ${baseItem.id}.`);
    invariant(
      equalJson(baseItem, withoutDigest(candidateItem)),
      `Schema migration изменила данные позиции ${baseItem.id}.`,
    );
  }

  invariant(baseFiles.size === candidateFiles.size, 'Schema migration не должна менять logo files.');
  for (const [filePath, baseBytes] of baseFiles) {
    const candidateBytes = candidateFiles.get(filePath);
    invariant(candidateBytes && baseBytes.equals(candidateBytes), `Schema migration изменила файл: ${filePath}`);
  }
}

function itemMap(catalog) {
  return new Map(catalog.items.map((item) => [item.id, item]));
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCatalogAsset(filePath) {
  return filePath === 'catalog.json' || filePath.startsWith('logos/');
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.equals(right);
}

function assertNoNewDuplicateImages(baseFiles, candidateFiles, allowedNewFiles) {
  const contentOwners = new Map();
  const remember = (filePath, bytes) => {
    const digest = sha256Hex(bytes);
    const owners = contentOwners.get(digest) || [];
    owners.push({ filePath, bytes });
    contentOwners.set(digest, owners);
  };

  for (const [filePath, bytes] of baseFiles) {
    remember(filePath, bytes);
  }

  for (const filePath of [...allowedNewFiles].sort()) {
    const bytes = candidateFiles.get(filePath);
    invariant(bytes, `Новый файл отсутствует: ${filePath}`);
    const digest = sha256Hex(bytes);
    const duplicate = (contentOwners.get(digest) || []).find((owner) => sameBytes(owner.bytes, bytes));
    invariant(!duplicate, `Изображение ${filePath} дублирует ${duplicate?.filePath}.`);
    remember(filePath, bytes);
  }
}

function validateMutation(baseCatalog, candidateCatalog, baseFiles, candidateFiles) {
  const baseItems = itemMap(baseCatalog);
  const candidateItems = itemMap(candidateCatalog);
  const changedIds = new Set();
  const allowedNewFiles = new Set();
  const allowedDeletedFiles = new Set();

  for (const [id, baseItem] of baseItems) {
    const candidateItem = candidateItems.get(id);
    if (!candidateItem) {
      changedIds.add(id);
      if (!candidateFiles.has(baseItem.path)) {
        allowedDeletedFiles.add(baseItem.path);
      }
      continue;
    }
    if (equalJson(baseItem, candidateItem)) continue;
    changedIds.add(id);
    invariant(candidateItem.version === baseItem.version + 1, `${id}: version должна увеличиться ровно на 1.`);
    invariant(candidateItem.path !== baseItem.path, `${id}: новая версия должна использовать новый path.`);
    invariant(candidateFiles.has(baseItem.path), `${id}: старый versioned-файл нельзя удалять при обновлении.`);
    allowedNewFiles.add(candidateItem.path);
  }

  for (const [id, candidateItem] of candidateItems) {
    if (baseItems.has(id)) continue;
    changedIds.add(id);
    invariant(candidateItem.version === 1, `${id}: новая позиция должна начинаться с version 1.`);
    allowedNewFiles.add(candidateItem.path);
  }

  invariant(changedIds.size > 0, 'catalog_version изменён, но позиции каталога не изменились.');
  invariant(changedIds.size <= 20, 'Один PR может менять не более 20 позиций каталога.');
  invariant(candidateCatalog.catalog_version === baseCatalog.catalog_version + 1, 'catalog_version должна увеличиться ровно на 1.');
  assertNoNewDuplicateImages(baseFiles, candidateFiles, allowedNewFiles);

  for (const [filePath, baseBytes] of baseFiles) {
    if (!isCatalogAsset(filePath) || filePath === 'catalog.json') continue;
    const candidateBytes = candidateFiles.get(filePath);
    if (!candidateBytes) {
      invariant(allowedDeletedFiles.has(filePath), `Удалён недопустимый файл: ${filePath}`);
      continue;
    }
    invariant(baseBytes.equals(candidateBytes), `Опубликованный файл нельзя перезаписывать: ${filePath}`);
  }

  for (const filePath of candidateFiles.keys()) {
    if (!isCatalogAsset(filePath) || filePath === 'catalog.json' || baseFiles.has(filePath)) continue;
    invariant(allowedNewFiles.has(filePath), `Добавлен файл вне ожидаемых versioned paths: ${filePath}`);
  }
}

export async function validateRepository(candidateRoot, baseRoot = null) {
  const candidateCatalog = await readCatalog(candidateRoot);
  const candidateVisualIndex = await readVisualIndex(candidateRoot, false);
  const candidateFiles = await collectLogoFiles(candidateRoot);
  validateLogoFiles(candidateCatalog, candidateVisualIndex, candidateFiles);

  if (baseRoot) {
    const baseCatalog = await readCatalog(baseRoot);
    const baseVisualIndex = await readVisualIndex(baseRoot, false);
    const baseFiles = await collectLogoFiles(baseRoot);
    validateLogoFiles(baseCatalog, baseVisualIndex, baseFiles);
    invariant(
      !baseVisualIndex || candidateVisualIndex,
      'visual-index.json нельзя удалить после bootstrap.',
    );
    const catalogChanged = !equalJson(baseCatalog, candidateCatalog);
    if (baseCatalog.schema_version !== candidateCatalog.schema_version) {
      validateSchemaMigration(baseCatalog, candidateCatalog, baseFiles, candidateFiles);
    } else if (!catalogChanged) {
      for (const [filePath, baseBytes] of baseFiles) {
        if (!isCatalogAsset(filePath) || filePath === 'catalog.json') continue;
        const candidateBytes = candidateFiles.get(filePath);
        invariant(candidateBytes && baseBytes.equals(candidateBytes), `Каталог не менялся, но файл изменён: ${filePath}`);
      }
      for (const filePath of candidateFiles.keys()) {
        if (!isCatalogAsset(filePath) || filePath === 'catalog.json') continue;
        invariant(baseFiles.has(filePath), `Каталог не менялся, но добавлен файл: ${filePath}`);
      }
    } else {
      validateMutation(baseCatalog, candidateCatalog, baseFiles, candidateFiles);
    }
    if (baseVisualIndex && candidateVisualIndex) {
      validateVisualIndexTransition(
        baseVisualIndex,
        candidateVisualIndex,
        baseFiles,
        candidateFiles,
        catalogChanged,
      );
    } else if (candidateVisualIndex) {
      validateVisualIndexBootstrap(candidateVisualIndex);
    }
  } else if (candidateVisualIndex) {
    validateVisualIndexBootstrap(candidateVisualIndex);
  }

  return {
    schema_version: candidateCatalog.schema_version,
    catalog_version: candidateCatalog.catalog_version,
    items: candidateCatalog.items.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidateRoot = path.resolve(process.argv[2] || '.');
  const baseRoot = process.argv[3] ? path.resolve(process.argv[3]) : null;
  try {
    const result = await validateRepository(candidateRoot, baseRoot);
    process.stdout.write(`Catalog valid: schema=${result.schema_version} version=${result.catalog_version} items=${result.items}\n`);
  } catch (error) {
    process.stderr.write(`Catalog validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
