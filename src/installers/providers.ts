/**
 * Installer sources: list installer files and download one. One interface,
 * one class per provider type:
 *
 *   nextcloud-share  public share URL https://host/s/<token>; listed over
 *                    WebDAV at https://host/public.php/webdav/ with Basic auth
 *                    user=<token>, password=<share password or empty>
 *   webdav           any WebDAV folder URL, optional user + password
 *   local            a folder on this server (mounted share, USB copy, ...)
 *   http             a URL to a single file, or an index page whose links
 *                    point at the files
 *   google-drive     not implemented yet: throws a clear error
 *
 * WebDAV is plain fetch + PROPFIND (Depth: 1, walked folder by folder; many
 * servers refuse Depth: infinity). The npm `webdav` client (5.x) works too but
 * brings 15 dependencies for two requests we already make here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InstallerSource } from './settings.js';

export interface InstallerFile {
  /** File name, e.g. skyspark-4.0.7.zip */
  name: string;
  /** Provider-specific path or URL used by download(). */
  ref: string;
  /** Folder path inside the source, for display. */
  folder: string;
  size?: number;
  modified?: string;
}

export interface InstallerProvider {
  readonly type: string;
  /** All files under the source (folders walked up to `maxDepth`). */
  list(maxDepth?: number): Promise<InstallerFile[]>;
  /** Download to `dest` (created), returns bytes written. */
  download(file: InstallerFile, dest: string, onProgress?: (bytes: number) => void): Promise<number>;
}

export class InstallerSourceError extends Error {}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function streamToFile(res: Response, dest: string, onProgress?: (n: number) => void): Promise<number> {
  if (!res.ok || !res.body) throw new InstallerSourceError(`download failed: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let n = 0;
  const src = Readable.fromWeb(res.body as any);
  src.on('data', (c: Buffer) => { n += c.length; onProgress?.(n); });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return n;
}

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export interface DavEntry { href: string; isDir: boolean; size?: number; modified?: string }

/** Parse a PROPFIND multistatus body. Namespace prefixes vary (d:, D:, none). */
export function parsePropfind(xml: string): DavEntry[] {
  const out: DavEntry[] = [];
  const responses = xml.match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi) ?? [];
  for (const r of responses) {
    const href = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/i.exec(r)?.[1];
    if (!href) continue;
    const isDir = /<(?:\w+:)?collection\s*\/>/i.test(r);
    const len = /<(?:\w+:)?getcontentlength>(\d+)</i.exec(r)?.[1];
    const mod = /<(?:\w+:)?getlastmodified>([^<]+)</i.exec(r)?.[1];
    out.push({ href: xmlDecode(href), isDir, size: len ? Number(len) : undefined, modified: mod ? new Date(mod).toISOString() : undefined });
  }
  return out;
}

export class WebDavProvider implements InstallerProvider {
  readonly type: string = 'webdav';
  constructor(protected baseUrl: string, protected user?: string, protected pass?: string) {
    if (!/^https?:\/\//i.test(baseUrl)) throw new InstallerSourceError(`not an http(s) URL: ${baseUrl}`);
    if (!this.baseUrl.endsWith('/')) this.baseUrl += '/';
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.user !== undefined ? { Authorization: basicAuth(this.user, this.pass ?? ''), ...extra } : extra;
  }

  private async propfind(url: string): Promise<DavEntry[]> {
    const res = await fetch(url, { method: 'PROPFIND', headers: this.headers({ Depth: '1' }) });
    if (res.status === 401 || res.status === 403) throw new InstallerSourceError(`WebDAV refused the credentials (HTTP ${res.status})`);
    if (res.status !== 207) throw new InstallerSourceError(`WebDAV PROPFIND ${url} failed: HTTP ${res.status}`);
    return parsePropfind(await res.text());
  }

  async list(maxDepth = 4): Promise<InstallerFile[]> {
    const origin = new URL(this.baseUrl).origin;
    const rootPath = new URL(this.baseUrl).pathname;
    const files: InstallerFile[] = [];
    const walk = async (url: string, depth: number): Promise<void> => {
      const selfPath = new URL(url).pathname;
      for (const e of await this.propfind(url)) {
        const p = e.href.startsWith('http') ? new URL(e.href).pathname : e.href;
        if (decodeURIComponent(p).replace(/\/$/, '') === decodeURIComponent(selfPath).replace(/\/$/, '')) continue;
        const abs = origin + p;
        if (e.isDir) {
          if (depth < maxDepth) await walk(abs, depth + 1);
          continue;
        }
        const rel = decodeURIComponent(p.slice(rootPath.length));
        files.push({
          name: path.posix.basename(rel),
          ref: abs,
          folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
          size: e.size,
          modified: e.modified,
        });
      }
    };
    await walk(this.baseUrl, 1);
    return files;
  }

  async download(file: InstallerFile, dest: string, onProgress?: (n: number) => void): Promise<number> {
    return streamToFile(await fetch(file.ref, { headers: this.headers() }), dest, onProgress);
  }
}

/** `https://host/s/<token>` (optionally `/download` or `?path=`) -> WebDAV root + token. */
export function parseNextcloudShareUrl(shareUrl: string): { davUrl: string; token: string } {
  let u: URL;
  try { u = new URL(shareUrl); } catch { throw new InstallerSourceError(`not a URL: ${shareUrl}`); }
  const m = /^(.*?)\/(?:index\.php\/)?s\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!m) throw new InstallerSourceError('not a Nextcloud public share URL (expected https://<host>/s/<token>)');
  const sub = u.searchParams.get('path');
  const base = `${u.origin}${m[1]}/public.php/webdav/`;
  const davUrl = sub && sub !== '/' ? base + sub.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/') + '/' : base;
  return { davUrl, token: m[2] };
}

export class NextcloudShareProvider extends WebDavProvider {
  readonly type = 'nextcloud-share';
  constructor(shareUrl: string, password?: string) {
    const { davUrl, token } = parseNextcloudShareUrl(shareUrl);
    super(davUrl, token, password ?? '');
  }
}

export class LocalFolderProvider implements InstallerProvider {
  readonly type = 'local';
  constructor(private root: string) {}

  async list(maxDepth = 4): Promise<InstallerFile[]> {
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw new InstallerSourceError(`folder not found: ${this.root}`);
    }
    const out: InstallerFile[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1); continue; }
        if (!e.isFile()) continue;
        const st = fs.statSync(full);
        const rel = path.relative(this.root, full);
        out.push({ name: e.name, ref: full, folder: path.dirname(rel) === '.' ? '' : path.dirname(rel), size: st.size, modified: st.mtime.toISOString() });
      }
    };
    walk(this.root, 1);
    return out;
  }

  async download(file: InstallerFile, dest: string): Promise<number> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.ref, dest);
    return fs.statSync(dest).size;
  }
}

export class HttpProvider implements InstallerProvider {
  readonly type = 'http';
  constructor(private url: string, private user?: string, private pass?: string) {
    if (!/^https?:\/\//i.test(url)) throw new InstallerSourceError(`not an http(s) URL: ${url}`);
  }

  private headers(): Record<string, string> {
    return this.user ? { Authorization: basicAuth(this.user, this.pass ?? '') } : {};
  }

  /** A URL ending in a file name is one file; anything else is an index page. */
  async list(): Promise<InstallerFile[]> {
    const u = new URL(this.url);
    const last = path.posix.basename(u.pathname);
    if (/\.(zip|tar\.gz|tgz)$/i.test(last)) return [{ name: decodeURIComponent(last), ref: this.url, folder: '' }];
    const res = await fetch(this.url, { headers: this.headers() });
    if (!res.ok) throw new InstallerSourceError(`GET ${this.url} failed: HTTP ${res.status}`);
    const html = await res.text();
    const seen = new Set<string>();
    const out: InstallerFile[] = [];
    for (const m of html.matchAll(/href\s*=\s*["']([^"'#?]+\.(?:zip|tar\.gz|tgz))["']/gi)) {
      const abs = new URL(m[1], this.url).toString();
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ name: decodeURIComponent(path.posix.basename(new URL(abs).pathname)), ref: abs, folder: '' });
    }
    return out;
  }

  async download(file: InstallerFile, dest: string, onProgress?: (n: number) => void): Promise<number> {
    return streamToFile(await fetch(file.ref, { headers: this.headers() }), dest, onProgress);
  }
}

export class GoogleDriveProvider implements InstallerProvider {
  readonly type = 'google-drive';
  async list(): Promise<InstallerFile[]> {
    throw new InstallerSourceError('Google Drive sources are not configured on this server yet. Use a Nextcloud share, WebDAV, a local folder or an HTTP URL.');
  }
  async download(): Promise<number> {
    throw new InstallerSourceError('Google Drive sources are not configured on this server yet.');
  }
}

export function createProvider(source: InstallerSource | null, secret: string | null): InstallerProvider {
  if (!source) throw new InstallerSourceError('No installer source is set. Add one in Settings > Installer sources.');
  switch (source.provider) {
    case 'nextcloud-share': return new NextcloudShareProvider(source.location, secret ?? '');
    case 'webdav': return new WebDavProvider(source.location, source.username, secret ?? undefined);
    case 'local': return new LocalFolderProvider(source.location);
    case 'http': return new HttpProvider(source.location, source.username, secret ?? undefined);
    case 'google-drive': return new GoogleDriveProvider();
  }
}
