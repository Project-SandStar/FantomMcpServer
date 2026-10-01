/**
 * Dev-mode marker.
 *
 * Some conveniences are only acceptable on a developer's own machine, e.g.
 * the dashboard's `#auth=` fragment sign-in used by browser agents. They are
 * enabled by the presence of a marker file, never by an environment variable
 * or a config key that could be set by accident on a shared host:
 *
 *   config/dev-mode
 *
 * The file's content is ignored. It is gitignored, so a fresh checkout or a
 * public snapshot never has it. `/health` reports the flag as `devMode`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInstallRoot } from '../utils/installRoot.js';

export const DEV_MODE_MARKER = 'config/dev-mode';

export function devModeMarkerPath(): string {
  return path.join(getInstallRoot(), DEV_MODE_MARKER);
}

/** True only when the marker file exists. Checked on every call; it is one stat. */
export function isDevMode(): boolean {
  try {
    return fs.existsSync(devModeMarkerPath());
  } catch {
    return false;
  }
}
