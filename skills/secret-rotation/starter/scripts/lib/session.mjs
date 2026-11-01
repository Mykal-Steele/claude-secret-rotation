import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRETS } from '../secrets.manifest.mjs';
import { CONFIG } from '../secrets.config.mjs';
import { createReader } from './current.mjs';
import { acquireLock, ensurePrivateDir, redact, stateDir as stateDirFor } from './safety.mjs';

// What every step of a run shares: where the repo is, where the old values are kept,
// how to read the value in use now, and the list of values to scrub from any output.
export class Fatal extends Error {}
export class Usage extends Error {}

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const stateDir = stateDirFor(process.env, os.homedir(), CONFIG.name);

const reader = createReader({ root, secrets: SECRETS, productionFile: CONFIG.productionFile });
export const readCurrent = reader.read;
export const readFile = reader.readFile;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const known = new Set();
export const track = (value) => {
  if (value) known.add(value);
};
export const scrub = (text) => redact(text, [...known]);

let release;
export function ensureStateDir() {
  try {
    ensurePrivateDir(stateDir);
  } catch (error) {
    throw new Fatal(error.message);
  }
}

// One rotation at a time, and always in a folder only this user can read.
export function lock() {
  ensureStateDir();
  try {
    release = acquireLock(stateDir);
  } catch (error) {
    throw new Fatal(error.message);
  }
}
export const unlock = () => release?.();
