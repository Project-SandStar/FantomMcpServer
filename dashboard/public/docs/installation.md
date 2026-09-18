# Installation Guide

This guide covers how to install and configure the Fantom MCP Server for various AI coding assistants and IDEs.

## Prerequisites

Before installing, ensure you have:

- **Node.js** >= 18.0.0
- **npm** (comes with Node.js)

## Building the Server

First, clone and build the MCP server:

```bash
cd {{SERVER_DIR}}
npm install
npm run build
```

This compiles TypeScript to the `build/` directory.

---

## Important: DATABASE_URL for stdio Mode

The server reads `DATABASE_URL` from a `.env` file relative to the **current working directory** (`process.cwd()`). When an AI assistant spawns the stdio MCP, the cwd is usually the assistant's project — **not** `{{SERVER_DIR}}` — so `.env` is never found and Prisma cannot open `.cache/fantom.db`.

Symptom: tools backed by the in-memory index (e.g. `getFantomCodeStats`) work, but Prisma-backed tools (e.g. `listFantomProjects`, code/graph queries) fail with a SQLite "unable to open database" error.

**Fix:** pass an absolute `DATABASE_URL` via the MCP server's `env` block. Apply this to **every** stdio config snippet below:

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"],
      "env": {
        "DATABASE_URL": "file:{{SERVER_DIR}}/.cache/fantom.db"
      }
    }
  }
}
```

If you have multiple per-project blocks (e.g. duplicated in `~/.claude.json`), update each one. Restart the AI assistant after editing.

### Built-in fallback (since recent versions)

`src/config/index.ts` now loads `.env` relative to the **server's own location** (resolved via `import.meta.url` → `__dirname` → `../../.env`) rather than `process.cwd()`. As a result, the bundled `.env` at `{{SERVER_DIR}}/.env` is picked up regardless of where the assistant spawns the stdio process. The explicit `env.DATABASE_URL` block above is still recommended (it overrides any `.env` and makes the config self-contained), but if you've pulled the latest build the server should also work without it as long as `{{SERVER_DIR}}/.env` exists.

---

## Transport Modes

The server supports two transport modes:

| Mode | Use Case | Multi-Client | Description |
|------|----------|--------------|-------------|
| **stdio** | Single client (default) | No | Standard input/output - spawned per client |
| **http** | Multi-client server | Yes | HTTP server on port 3847 with sessions |

---

## Claude Code CLI

### Stdio Transport (Recommended)

```bash
claude mcp add fantom-mcp -- node {{SERVER_DIR}}/build/index.js
```

Or manually edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"]
    }
  }
}
```

### HTTP Transport

First, start the HTTP server:

```bash
cd {{SERVER_DIR}}
npm run start:http
```

Then add to Claude Code:

```bash
claude mcp add --transport http fantom-mcp http://localhost:{{PORT}}/mcp
```

---

## Claude Desktop App

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"]
    }
  }
}
```

On Windows, the config file is at:
`%APPDATA%\Claude\claude_desktop_config.json`

---

## VS Code Extensions

### Cline Extension

Add to Cline's MCP settings (`.cline/mcp_settings.json` or via UI):

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"]
    }
  }
}
```

### Continue Extension

Add to Continue's config (`.continue/config.json`):

```json
{
  "mcpServers": [
    {
      "name": "fantom-mcp",
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"]
    }
  ]
}
```

---

## Cursor

Add to `.cursor/mcp.json` in your project root or global settings:

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"]
    }
  }
}
```

---

## Windsurf

Add to Windsurf's MCP configuration:

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "command": "node",
      "args": ["{{SERVER_DIR}}/build/index.js"]
    }
  }
}
```

---

## HTTP Server Management

For running the server as a background service:

### Shell Scripts

```bash
# Start server in background
./scripts/start-server.sh

# Check server status
./scripts/status-server.sh

# Stop server
./scripts/stop-server.sh
```

### PM2 Process Manager

```bash
# Install PM2 globally (if not installed)
npm install -g pm2

# Start with PM2
npm run daemon:start

# View logs
npm run daemon:logs

# Stop server
npm run daemon:stop
```

---

## Environment Variables

Configure the server via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3847` | HTTP server port (when using http transport) |
| `ADMIN_USER` | `admin` | Admin API username |
| `ADMIN_PASS` | `admin` | Admin API password |
| `CACHE_ENABLED` | `true` | Enable/disable documentation caching |

Create a `.env` file in the project root to set these:

```env
MCP_TRANSPORT=http
MCP_PORT=3847
ADMIN_USER=myadmin
ADMIN_PASS=securepassword
```

---

## Verifying Installation

After installation, verify the server is working:

### For Stdio Mode

Run the server directly to check for errors:

```bash
node {{SERVER_DIR}}/build/index.js
```

You should see initialization messages without errors.

### For HTTP Mode

1. Start the server: `npm run start:http`
2. Check health endpoint: `curl http://localhost:{{PORT}}/health`
3. Access the dashboard: `http://localhost:{{PORT}}/dashboard/`

---

## Troubleshooting

### Server Not Starting

- Ensure Node.js >= 18 is installed: `node --version`
- Rebuild the project: `npm run clean && npm run build`
- Check for port conflicts (HTTP mode): `lsof -i :3847`

### Tools Not Appearing

- Restart your AI assistant/IDE after adding MCP configuration
- Check the MCP server logs for errors
- Verify the path to `build/index.js` is correct

### Cache Issues

Clear the cache and rebuild:

```bash
npm run clean
npm run build
```

### Permission Errors

Ensure the build directory has execute permissions:

```bash
chmod +x {{SERVER_DIR}}/build/index.js
```
