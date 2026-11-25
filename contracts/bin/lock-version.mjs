#!/usr/bin/env node
// Writes vocabulary/v<N>.lock.json for a version that has just been
// published. Usage: npm run lock -- <N>
import { writeLock } from '../lib/lock.mjs';

const arg = process.argv[2];
if (!/^[1-9][0-9]*$/.test(arg ?? '')) {
  console.error('usage: npm run lock -- <version number>');
  process.exit(2);
}
try {
  console.log(`wrote ${writeLock(Number(arg))}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
