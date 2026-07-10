#!/usr/bin/env node

import process from 'node:process';
import { createPasswordHash } from '../lib/crypto.js';

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Команду нужно запустить в интерактивном терминале.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error = null) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Операция отменена.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ' && value.length < 256) {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

try {
  const password = await readHidden('Новый общий пароль (минимум 20 символов): ');
  const confirmation = await readHidden('Повторите пароль: ');
  if (password !== confirmation) {
    throw new Error('Пароли не совпадают.');
  }
  process.stdout.write(`${await createPasswordHash(password)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
