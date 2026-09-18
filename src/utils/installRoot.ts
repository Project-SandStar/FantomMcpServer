/**
 * Single source of truth for the fantom-mcp install root and its derived
 * paths. Every cache, database, and model file MUST resolve through here —
 * not via process.cwd() — so a process spawned from another directory
 * (e.g. an MCP client launched inside a user project) doesn't accidentally
 * create a stray .cache/ tree alongside the user's source.
 *
 * Override with MCPFANTOM_CACHE_DIR (absolute path) when you need to point
 * at a non-default cache location, e.g. running tests against an isolated
 * graph store.
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

export function getInstallRoot(): string {
  if (cachedRoot) return cachedRoot;
  // This file lives at <root>/build/utils/installRoot.js (compiled) or
  // <root>/src/utils/installRoot.ts (source). Either way, climb two levels.
  const here = path.dirname(fileURLToPath(import.meta.url));
  cachedRoot = path.resolve(here, '..', '..');
  return cachedRoot;
}

export function getCacheDir(): string {
  const override = process.env.MCPFANTOM_CACHE_DIR;
  const dir = override && path.isAbsolute(override)
    ? override
    : path.join(getInstallRoot(), '.cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getCachePath(...segments: string[]): string {
  return path.join(getCacheDir(), ...segments);
}
