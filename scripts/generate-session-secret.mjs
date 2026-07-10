#!/usr/bin/env node

import process from 'node:process';
import { bytesToBase64 } from '../lib/crypto.js';

process.stdout.write(`${bytesToBase64(crypto.getRandomValues(new Uint8Array(48)))}\n`);
