/**
 * OAuth Authorization Page HTML Renderer
 *
 * Renders a login/consent page for the OAuth authorization flow.
 */

import { SCOPE_DESCRIPTIONS } from './tokenUtils.js';

export interface AuthorizePageOptions {
  authId: string;
  clientName: string;
  clientId: string;
  scopes: string[];
  redirectUri: string;
  error?: string;
}

/**
 * Render the OAuth authorization page HTML
 */
export function renderAuthorizePage(options: AuthorizePageOptions): string {
  const { authId, clientName, clientId, scopes, error } = options;

  const scopeList = scopes
    .map(scope => {
      const description = SCOPE_DESCRIPTIONS[scope] || scope;
      return `<li class="scope-item">${escapeHtml(description)}</li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In - Fantom MCP Server</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1e293b 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 420px;
    }

    .header {
      text-align: center;
      margin-bottom: 24px;
    }

    .logo {
      width: 64px;
      height: 64px;
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
    }

    .logo svg {
      width: 32px;
      height: 32px;
      color: #60a5fa;
    }

    .title {
      color: #f8fafc;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .subtitle {
      color: #94a3b8;
      font-size: 14px;
    }

    .card {
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(51, 65, 85, 1);
      border-radius: 16px;
      padding: 32px;
      backdrop-filter: blur(8px);
    }

    .client-info {
      background: rgba(15, 23, 42, 0.5);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
    }

    .client-name {
      color: #f8fafc;
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 4px;
    }

    .client-id {
      color: #64748b;
      font-size: 12px;
      font-family: monospace;
    }

    .scopes-section {
      margin-bottom: 24px;
    }

    .scopes-title {
      color: #94a3b8;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }

    .scope-list {
      list-style: none;
    }

    .scope-item {
      color: #cbd5e1;
      font-size: 14px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(51, 65, 85, 0.5);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .scope-item:last-child {
      border-bottom: none;
    }

    .scope-item::before {
      content: '';
      width: 6px;
      height: 6px;
      background: #60a5fa;
      border-radius: 50%;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-label {
      display: block;
      color: #cbd5e1;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .form-input {
      width: 100%;
      padding: 12px 16px;
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(51, 65, 85, 1);
      border-radius: 8px;
      color: #f8fafc;
      font-size: 14px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-input::placeholder {
      color: #64748b;
    }

    .form-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }

    .error-message {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      color: #f87171;
      font-size: 14px;
      margin-bottom: 20px;
    }

    .error-icon {
      flex-shrink: 0;
    }

    .submit-btn {
      width: 100%;
      padding: 14px 24px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    .submit-btn:hover {
      background: #2563eb;
    }

    .submit-btn:focus {
      outline: none;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.4);
    }

    .submit-btn:disabled {
      background: rgba(59, 130, 246, 0.5);
      cursor: not-allowed;
    }

    .footer {
      margin-top: 24px;
      text-align: center;
    }

    .footer-text {
      color: #64748b;
      font-size: 12px;
    }

    .default-creds {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(51, 65, 85, 0.5);
      text-align: center;
    }

    .default-creds-text {
      color: #64748b;
      font-size: 13px;
    }

    .default-creds-text code {
      color: #94a3b8;
      font-family: monospace;
      background: rgba(15, 23, 42, 0.5);
      padding: 2px 6px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </div>
      <h1 class="title">Fantom MCP Server</h1>
      <p class="subtitle">Sign in to authorize access</p>
    </div>

    <div class="card">
      <div class="client-info">
        <div class="client-name">${escapeHtml(clientName)}</div>
        <div class="client-id">Client ID: ${escapeHtml(clientId)}</div>
      </div>

      ${scopes.length > 0 ? `
      <div class="scopes-section">
        <div class="scopes-title">Requested Permissions</div>
        <ul class="scope-list">
          ${scopeList}
        </ul>
      </div>
      ` : ''}

      <form method="POST" action="/oauth/login">
        <input type="hidden" name="auth_id" value="${escapeHtml(authId)}" />

        ${error ? `
        <div class="error-message">
          <svg class="error-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>${escapeHtml(error)}</span>
        </div>
        ` : ''}

        <div class="form-group">
          <label class="form-label" for="username">Username</label>
          <input
            type="text"
            id="username"
            name="username"
            class="form-input"
            placeholder="Enter your username"
            autocomplete="username"
            required
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="password">Password</label>
          <input
            type="password"
            id="password"
            name="password"
            class="form-input"
            placeholder="Enter your password"
            autocomplete="current-password"
            required
          />
        </div>

        <button type="submit" class="submit-btn">
          Sign In & Authorize
        </button>
      </form>

      <div class="default-creds">
        <p class="default-creds-text">
          Default credentials: <code>admin</code> / <code>admin</code>
        </p>
      </div>
    </div>

    <div class="footer">
      <p class="footer-text">Fantom MCP Server - OAuth 2.1 Authorization</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render an error page for OAuth errors
 */
export function renderErrorPage(error: string, description?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Fantom MCP Server</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1e293b 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 420px;
      text-align: center;
    }

    .error-icon {
      width: 64px;
      height: 64px;
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }

    .error-icon svg {
      width: 32px;
      height: 32px;
      color: #f87171;
    }

    .title {
      color: #f8fafc;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .description {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    </div>
    <h1 class="title">${escapeHtml(error)}</h1>
    ${description ? `<p class="description">${escapeHtml(description)}</p>` : ''}
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, char => map[char] || char);
}
