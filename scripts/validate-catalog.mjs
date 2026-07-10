#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateCatalog } from '../lib/catalog.js';
import { inspectImage } from '../lib/image.js';

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

function validateLogoFiles(catalog, files) {
  const catalogPaths = new Set(catalog.items.map((item) => item.path));
  for (const item of catalog.items) {
    invariant(files.has(item.path), `Файл из catalog.json отсутствует: ${item.path}`);
  }

  for (const [filePath, bytes] of files) {
    if (!filePath.startsWith('logos/')) continue;
    if (filePath === 'logos/.gitkeep') continue;
    invariant(/\.(?:jpg|png|webp)$/.test(filePath), `В logos запрещён тип файла: ${filePath}`);
    const image = inspectImage(bytes);
    const extension = filePath.split('.').pop();
    invariant(extension === extensionForMime(image.mime), `MIME не совпадает с расширением: ${filePath}`);

    if (!catalogPaths.has(filePath)) {
      // Unlisted versioned files are valid immutable history.
      invariant(VERSIONED_LOGO_PATH.test(filePath), `Неописанный файл не является versioned history: ${filePath}`);
    }
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
  const candidateFiles = await collectLogoFiles(candidateRoot);
  validateLogoFiles(candidateCatalog, candidateFiles);

  if (baseRoot) {
    const baseCatalog = await readCatalog(baseRoot);
    const baseFiles = await collectLogoFiles(baseRoot);
    if (equalJson(baseCatalog, candidateCatalog)) {
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
