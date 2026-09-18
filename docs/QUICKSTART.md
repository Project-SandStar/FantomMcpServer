# Quick Start Guide

Get the MCP Fantom Server up and running in minutes.

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build
```

## First Run

### Option 1: Quick Test (Recommended)

Use the default configuration to test with online Fantom documentation:

```bash
# Start the server (will begin indexing documentation)
npm run dev
```

The server will:
1. Connect to https://fantom.org/doc
2. Crawl and parse the documentation (takes 2-5 minutes)
3. Build the search index
4. Cache results in `.cache/flexsearch-fantom.json`
5. Start the MCP server

**Note**: The initial crawl takes time but subsequent starts are instant using the cache.

### Option 2: Test Locally

If you have Fantom documentation locally:

```bash
# Edit fantom-config.json
{
  "docsPath": "/path/to/fantom/doc"
}

# Start the server
npm run dev
```

## Verify Installation

### Test the Cache

After the server has run once:

```bash
npm run test:cache
```

Expected output:
```
✓ Found documentation cache with XXX items
```

### Test Search

```bash
npm run test:search
```

This will run sample searches and show results.

## Using with Claude Desktop

1. **Find your config file**:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

2. **Add the server configuration**:

```json
{
  "mcpServers": {
    "fantom": {
      "command": "node",
      "args": ["/absolute/path/to/mcpfantom/build/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/mcpfantom` with your actual path.

3. **Restart Claude Desktop**

4. **Test it**:

In Claude, try asking:
- "Search Fantom docs for Str"
- "What is sys::Int in Fantom?"
- "Show me Fantom HTTP client examples"
- "List all Fantom pods"

## Using with Other MCP Clients

The server uses stdio transport and follows the MCP specification. Configure your client to:

1. Run: `node /path/to/mcpfantom/build/index.js`
2. Use stdio for communication
3. Optional: Set environment variables for custom paths

## Example Queries

Once connected to an MCP client, try these:

### Search for Types

```
Search Fantom docs for "HttpClient"
```

### Get Type Details

```
Get details about sys::Str in Fantom
```

### Find Examples

```
Find Fantom code examples for file operations
```

### Browse Pods

```
List all Fantom pods
```

### Access Workflows

```
Show me the workflow for creating a Fantom pod
```

## Next Steps

1. **Explore Workflows**: Access built-in guides via MCP resources
   - `workflow://create-pod`
   - `workflow://use-fanr`
   - `workflow://haxall-basics`
   - `workflow://unit-testing`

2. **Customize Configuration**: Edit `fantom-config.json` for your needs

3. **Index Local Code**: (Coming in Milestone 2)
   Set `FANTOM_CODE_PATH` to index your `.fan` files

## Troubleshooting

### Server won't start

1. Check Node.js version: `node --version` (need >= 18)
2. Reinstall dependencies: `npm install`
3. Rebuild: `npm run build`

### Indexing takes too long

Reduce crawl depth in `fantom-config.json`:

```json
{
  "crawlSettings": {
    "maxDepth": 2
  }
}
```

### No results in search

1. Verify cache exists: `npm run test:cache`
2. If no cache, run server once: `npm run dev`
3. Check for errors in console output

### Claude can't find the server

1. Use absolute paths in config
2. Verify the path exists: `ls /path/to/mcpfantom/build/index.js`
3. Check file permissions
4. Restart Claude Desktop after config changes

## Getting Help

- Check the [README.md](README.md) for detailed documentation
- Review workflow guides in `workflows/` directory
- Check server logs for error messages
- Enable debug mode: `DEBUG=fantom-mcp:* npm run dev`
