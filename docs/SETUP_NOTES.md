# Important Notes for First-Time Setup

## Initial Documentation Crawl

The MCP Fantom Server needs to crawl and index Fantom documentation on first run. Here's what you need to know:

### Expected Behavior

1. **First Run Takes Time**: 2-5 minutes to crawl fantom.org
2. **Subsequent Runs Are Instant**: Uses cached data from `.cache/`
3. **Network Required**: Initial crawl requires internet connection

### Current Status - Fantom.org Structure

**Important**: The current parser is designed for the standard Fantom documentation structure. If you're seeing 0 items indexed, this is likely because:

1. **Fantom.org uses relative paths**: Links like `docTools/Setup` instead of full URLs
2. **The parser needs URL resolution**: This will be fixed in the next update

### Workaround for Testing

#### Option 1: Use Sample Data

Create a minimal cache file for testing:

```bash
mkdir -p .cache

cat > .cache/flexsearch-fantom.json << 'EOF'
{
  "metadata": {
    "version": "1.0.0",
    "timestamp": 1730620800000,
    "itemCount": 5,
    "source": "manual-sample"
  },
  "items": [
    {
      "id": "sys-str",
      "type": "type",
      "name": "Str",
      "qualifiedName": "sys::Str",
      "pod": "sys",
      "description": "Str represents a sequence of Unicode characters.",
      "url": "https://fantom.org/doc/sys/Str",
      "keywords": ["Str", "sys::Str", "sys", "string", "text"]
    },
    {
      "id": "sys-int",
      "type": "type",
      "name": "Int",
      "qualifiedName": "sys::Int",
      "pod": "sys",
      "description": "Int represents a signed 64-bit integer.",
      "url": "https://fantom.org/doc/sys/Int",
      "keywords": ["Int", "sys::Int", "sys", "integer", "number"]
    },
    {
      "id": "inet-httpclient",
      "type": "type",
      "name": "HttpClient",
      "qualifiedName": "inet::HttpClient",
      "pod": "inet",
      "description": "HttpClient is used to make HTTP requests.",
      "url": "https://fantom.org/doc/inet/HttpClient",
      "keywords": ["HttpClient", "inet::HttpClient", "inet", "http", "client", "web"]
    },
    {
      "id": "sys-file",
      "type": "type",
      "name": "File",
      "qualifiedName": "sys::File",
      "pod": "sys",
      "description": "File represents a file or directory in a file system.",
      "url": "https://fantom.org/doc/sys/File",
      "keywords": ["File", "sys::File", "sys", "file", "directory", "io"]
    },
    {
      "id": "concurrent-actor",
      "type": "type",
      "name": "Actor",
      "qualifiedName": "concurrent::Actor",
      "pod": "concurrent",
      "description": "Actor is used for concurrent programming with message passing.",
      "url": "https://fantom.org/doc/concurrent/Actor",
      "keywords": ["Actor", "concurrent::Actor", "concurrent", "concurrency", "async"]
    }
  ]
}
EOF
```

Then test:

```bash
node test-core.mjs
```

You should see 5 items indexed and search working!

#### Option 2: Use Local Documentation

If you have Fantom installed locally:

1. Edit `fantom-config.json`:
```json
{
  "docsPath": "/path/to/fantom/doc",
  ...
}
```

2. Or set environment variable:
```bash
export FANTOM_DOCS_PATH="/path/to/fantom/doc"
```

### Parser Fix Coming

The parser will be updated to:
- Properly resolve relative URLs
- Handle the actual fantom.org structure
- Extract content from pod documentation pages
- Follow links to individual type pages

### Testing the MCP Server Now

Even without crawled data, you can test the MCP server functionality:

1. **Create sample cache** (see Option 1 above)
2. **Start the server**:
   ```bash
   npm start
   ```
3. **Configure Claude Desktop** (see QUICKSTART.md)
4. **Test queries** in Claude:
   - "Search Fantom docs for Str"
   - "What is HttpClient in Fantom?"
   - "List Fantom pods"

### Next Steps

1. **Use sample data** for immediate testing
2. **Wait for parser update** for full crawling
3. **Or contribute** a fix to the parser! (see CONTRIBUTING.md)

The MCP protocol implementation, search functionality, and caching all work perfectly - we just need to update the parser for the specific fantom.org URL structure.
