#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { inspectImage } from '../lib/image.js';

const supportedExtension = /\.(?:jpe?g|png|webp)$/i;

async function collect(input, output = []) {
  const stats = await lstat(input);
  if (stats.isSymbolicLink()) {
    throw new Error(`Symlink запрещён: ${input}`);
  }
  if (stats.isDirectory()) {
    const entries = await readdir(input, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue;
      await collect(path.join(input, entry.name), output);
    }
    return output;
  }
  if (stats.isFile() && supportedExtension.test(input)) {
    output.push(input);
  }
  return output;
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  process.stderr.write('Usage: npm run inspect-images -- <file-or-directory> [...]\n');
  process.exitCode = 2;
} else {
  try {
    const files = [];
    for (const input of inputs) {
      await collect(path.resolve(input), files);
    }
    if (files.length === 0) {
      throw new Error('Поддерживаемые изображения не найдены.');
    }
    for (const file of files.sort((left, right) => left.localeCompare(right))) {
      const image = inspectImage(await readFile(file));
      process.stdout.write(`${path.basename(file)}\t${image.mime}\t${image.width}x${image.height}\t${image.bytes}\n`);
    }
    process.stdout.write(`Validated images: ${files.length}\n`);
  } catch (error) {
    process.stderr.write(`Image validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
