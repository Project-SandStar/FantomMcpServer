/**
 * Static bearer token in front of /mcp and /admin (fileSystemSideCar Task 8.3).
 *
 * FANTOM_API_TOKEN unset → the gate does nothing (local dev keeps working).
 * Set → /mcp and /admin need `Authorization: Bearer <token>` (or the
 * `X-Fantom-Api-Token` header). Exceptions:
 *   - POST /admin/indexing/report and GET /admin/indexing/context keep their
 *     own X-Fantom-Hook-Token check (receiver, Claude Code plugin hooks).
 *   - /admin with a Basic Auth header passes on to the existing user-store
 *     check, so the dashboard still works. /admin is never open.
 * A valid token on /admin acts as an admin user; on /mcp it replaces the
 * OAuth check (res.locals.apiTokenOk). /health stays open for healthchecks.
 * On /mcp only, a Bearer that is not the fixed token passes when
 * `verifyOAuthToken` says it is a live OAuth access token (e.g. minted by
 * POST /admin/oauth/token-grant with Basic Auth). The gate checks it itself,
 * so /mcp never opens when the downstream OAuth check is off; apiTokenOk stays
 * unset, so the /mcp handler still runs its own OAuth check.
 * TLS is terminated by the reverse proxy (deploy/Caddyfile), not here.
 */

import * as crypto from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import '../admin/types.js';

export const API_TOKEN_ENV = 'FANTOM_API_TOKEN';
const HOOK_ROUTES = new Set(['POST /admin/indexing/report', 'GET /admin/indexing/context']);

function sameToken(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 1024) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface ApiTokenGateOptions {
  token?: () => string | undefined;
  /** True only for a currently valid (known, unrevoked, unexpired) OAuth access token. */
  verifyOAuthToken?: (token: string) => Promise<boolean>;
}

export function apiTokenGate(opts: ApiTokenGateOptions = {}): RequestHandler {
  const readToken = opts.token ?? (() => process.env[API_TOKEN_ENV]);
  const deny = (res: Response) => {
    res.setHeader('WWW-Authenticate', 'Bearer realm="fantom-mcp"');
    res.status(401).json({ error: 'Valid bearer token required' });
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readToken()?.trim();
    if (!token) return next();
    const p = req.path;
    const isMcp = p === '/mcp' || p.startsWith('/mcp/');
    const isAdmin = p === '/admin' || p.startsWith('/admin/');
    if (!isMcp && !isAdmin) return next();
    if (HOOK_ROUTES.has(`${req.method} ${p}`)) return next();

    const auth = req.headers.authorization ?? '';
    const isBearer = /^Bearer /i.test(auth);
    const presented = isBearer ? auth.slice(7).trim() : req.get('x-fantom-api-token');
    if (sameToken(presented, token)) {
      res.locals.apiTokenOk = true;
      if (isAdmin) req.user = { id: 'api-token', username: 'api-token', role: 'admin', createdAt: '' };
      return next();
    }
    if (isAdmin && /^Basic /i.test(auth)) return next();
    const verify = opts.verifyOAuthToken;
    if (isMcp && isBearer && verify && typeof presented === 'string' && presented.length > 0 && presented.length <= 1024) {
      verify(presented).then(
        (ok) => (ok ? next() : deny(res)),
        () => deny(res),
      );
      return;
    }
    return deny(res);
  };
}
