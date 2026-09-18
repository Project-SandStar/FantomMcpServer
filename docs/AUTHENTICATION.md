# Authentication Guide

This document describes the OAuth 2.1 authentication system used by Fantom MCP Server.

## Overview

Fantom MCP Server uses OAuth 2.1 with PKCE (Proof Key for Code Exchange) for secure authentication. The implementation supports multiple concurrent sessions per user.

## Token Lifetimes

| Token Type | TTL | Description |
|------------|-----|-------------|
| Access Token | **1 hour** | Used for API authentication |
| Refresh Token | **30 days** | Used to obtain new access tokens |
| Authorization Code | 10 minutes | One-time use during OAuth flow |

## Multiple Sessions

Users can have multiple concurrent sessions. Each login creates:
- A new `OAuthSession` record
- Fresh access and refresh tokens
- Independent session tracking

Logging in from a different client or project does **not** invalidate existing sessions.

## Token Refresh

To avoid session timeouts, clients should use the refresh token to obtain new access tokens before expiration:

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
refresh_token=<your_refresh_token>
client_id=<your_client_id>
```

The server will return a new access token (valid for 1 hour) while keeping the same refresh token.

## Common Issues

### Session Timeout After 1 Hour

**Cause:** Access token expired and client is not using the refresh token.

**Solution:** Implement automatic token refresh in your client:
1. Store the refresh token securely
2. Before access token expires (or on 401 response), use the refresh token to get a new access token
3. Refresh tokens are valid for 30 days

### Multiple Projects Logging Out

**Cause:** This should not happen - sessions are independent. If you're experiencing this:
1. Check if your client is sharing token storage between projects
2. Ensure each project uses its own token storage
3. Verify the client is correctly handling token refresh

## Configuration

Token TTLs can be configured in `config/fantomMcpServer-config.json`:

```json
{
  "auth": {
    "accessTokenTtl": 3600,      // 1 hour (seconds)
    "refreshTokenTtl": 2592000,  // 30 days (seconds)
    "authCodeTtl": 600           // 10 minutes (seconds)
  }
}
```

Or via the Admin API:
```bash
curl -X PUT http://localhost:3847/admin/settings \
  -H "Authorization: Basic <credentials>" \
  -H "Content-Type: application/json" \
  -d '{"auth": {"accessTokenTtl": 7200}}'  # Extend to 2 hours
```

Environment variables:
- `ADMIN_USER` - Admin username (default: `admin`)
- `ADMIN_PASS` - Admin password (default: `admin`)

## Session Management

### View Active Sessions

Via Admin API:
```
GET /admin/sessions
Authorization: Basic <credentials>
```

### Revoke a Session

```
DELETE /admin/sessions/:sessionId
Authorization: Basic <credentials>
```

### Revoke All Sessions for a Client

```
DELETE /admin/sessions/client/:clientId
Authorization: Basic <credentials>
```

## Security Notes

- Access tokens are 96-character hex strings (48 bytes)
- Refresh tokens are 128-character hex strings (64 bytes)
- All tokens are cryptographically generated using `crypto.randomBytes()`
- PKCE with S256 challenge method is required for the authorization flow
- Timing-safe comparison is used for token verification