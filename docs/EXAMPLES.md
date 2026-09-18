# MCP Fantom Server Examples

This document provides practical examples of using the MCP Fantom Server.

## Table of Contents

- [Basic Searches](#basic-searches)
- [Advanced Searches](#advanced-searches)
- [Type Exploration](#type-exploration)
- [Pod Discovery](#pod-discovery)
- [Workflow Resources](#workflow-resources)
- [Integration Examples](#integration-examples)

## Basic Searches

### Search for a Type

**Query**: "Find information about the Str type in Fantom"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "Str",
    "limit": 5
  }
}
```

**Expected Response**:
```json
{
  "query": "Str",
  "resultsFound": 5,
  "results": [
    {
      "name": "Str",
      "qualifiedName": "sys::Str",
      "type": "type",
      "pod": "sys",
      "description": "Str represents a sequence of Unicode characters...",
      "url": "https://fantom.org/doc/sys/Str.html",
      "relevance": "exact",
      "score": "2.00"
    }
  ]
}
```

### Search for a Method

**Query**: "How do I use the split method in Fantom?"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "split",
    "type": "slot",
    "limit": 5
  }
}
```

### Search for Examples

**Query**: "Show me Fantom HTTP examples"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "HTTP",
    "type": "example",
    "limit": 10
  }
}
```

## Advanced Searches

### Filter by Pod

**Query**: "Search for file operations in the sys pod"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "file",
    "pod": "sys",
    "limit": 10
  }
}
```

### Search for Specific Qualified Name

**Query**: "Find inet::HttpClient"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "inet::HttpClient",
    "limit": 1
  }
}
```

### Broad Topic Search

**Query**: "Find everything related to concurrency in Fantom"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "concurrent actor thread",
    "limit": 20
  }
}
```

## Type Exploration

### Get Complete Type Information

**Query**: "Tell me everything about sys::File"

**MCP Tool Call**:
```json
{
  "name": "getFantomType",
  "arguments": {
    "qualifiedName": "sys::File"
  }
}
```

**Expected Response**:
```json
{
  "type": {
    "name": "File",
    "qualifiedName": "sys::File",
    "type": "type",
    "pod": "sys",
    "description": "File is used to represent files and directories...",
    "signature": "class File",
    "url": "https://fantom.org/doc/sys/File.html"
  },
  "slots": [
    {
      "name": "exists",
      "signature": "Bool exists()",
      "description": "Return if this file exists"
    },
    {
      "name": "readAllStr",
      "signature": "Str readAllStr(Charset charset := Charset.utf8)",
      "description": "Read the entire file as a string"
    }
  ]
}
```

### Explore Related Types

**Query**: "What types are in the inet pod?"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "",
    "pod": "inet",
    "type": "type",
    "limit": 50
  }
}
```

## Pod Discovery

### List All Pods

**Query**: "What Fantom pods are available?"

**MCP Tool Call**:
```json
{
  "name": "listFantomPods",
  "arguments": {}
}
```

**Expected Response**:
```json
{
  "pods": [
    { "name": "sys", "itemCount": 450 },
    { "name": "inet", "itemCount": 120 },
    { "name": "concurrent", "itemCount": 80 },
    { "name": "util", "itemCount": 95 },
    { "name": "web", "itemCount": 140 }
  ]
}
```

### Explore a Specific Pod

**Query**: "Show me everything in the concurrent pod"

**MCP Tool Call**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "",
    "pod": "concurrent",
    "limit": 100
  }
}
```

## Workflow Resources

### Access Workflow Guide

**Query**: "Show me how to create a Fantom pod"

**MCP Resource Call**:
```json
{
  "uri": "workflow://create-pod"
}
```

### Get fanr Publishing Guide

**Query**: "How do I publish a pod with fanr?"

**MCP Resource Call**:
```json
{
  "uri": "workflow://use-fanr"
}
```

### Learn Haxall

**Query**: "I want to learn Haxall"

**MCP Resource Call**:
```json
{
  "uri": "workflow://haxall-basics"
}
```

### Unit Testing Guide

**Query**: "How do I write tests in Fantom?"

**MCP Resource Call**:
```json
{
  "uri": "workflow://unit-testing"
}
```

## Integration Examples

### Claude Desktop Usage

Example conversation:

**User**: "I'm writing a Fantom HTTP client. What types should I use?"

**Assistant**: Let me search the Fantom documentation for HTTP client types.

*[Uses searchFantomDocs with query="HTTP client"]*

**Response**: "The main type you'll want to use is `inet::HttpClient`. Here's what I found:

1. **inet::HttpClient** - Main HTTP client class
   - Methods for GET, POST, PUT, DELETE requests
   - Cookie and header management
   - Connection pooling

2. **inet::HttpReq** - Represents an HTTP request
   - Configure headers, body, method
   - Set timeouts

3. **inet::HttpRes** - Represents an HTTP response
   - Access status code, headers, body
   - Read response content

Would you like to see code examples?"

**User**: "Yes, show me an example"

**Assistant**: *[Uses searchFantomDocs with query="HttpClient" type="example"]*

### VS Code Extension Usage

```typescript
// Example VS Code extension integration
import { MCPClient } from '@modelcontextprotocol/sdk/client';

async function searchFantomDocs(query: string) {
  const client = new MCPClient();
  
  const result = await client.callTool({
    name: 'searchFantomDocs',
    arguments: { query, limit: 10 }
  });
  
  return JSON.parse(result.content[0].text);
}

// Usage
const results = await searchFantomDocs('File operations');
showQuickPick(results.results.map(r => ({
  label: r.name,
  description: r.qualifiedName,
  detail: r.description
})));
```

### Custom MCP Client

```javascript
// Node.js custom client example
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

async function main() {
  // Spawn the MCP server
  const serverProcess = spawn('node', [
    '/path/to/mcpfantom/build/index.js'
  ]);

  // Create client with stdio transport
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['/path/to/mcpfantom/build/index.js']
  });

  const client = new Client({
    name: 'fantom-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  await client.connect(transport);

  // Search for documentation
  const result = await client.callTool({
    name: 'searchFantomDocs',
    arguments: {
      query: 'Actor',
      pod: 'concurrent',
      limit: 5
    }
  });

  console.log(JSON.stringify(result, null, 2));

  await client.close();
}

main();
```

## Complex Query Examples

### Find Best Practices

**Query**: "What's the recommended way to handle file I/O in Fantom?"

This would typically involve:
1. Search for File type
2. Search for I/O examples
3. Access workflow resources for best practices

**MCP Tool Sequence**:
```json
// 1. Get File type info
{
  "name": "getFantomType",
  "arguments": { "qualifiedName": "sys::File" }
}

// 2. Search for examples
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "file read write",
    "type": "example",
    "limit": 10
  }
}

// 3. Access best practices (future milestone)
{
  "uri": "workflow://best-practices-io"
}
```

### Debugging Assistance

**Query**: "I'm getting an IOErr when reading a file. What could be wrong?"

**MCP Tool Sequence**:
```json
// 1. Find IOErr documentation
{
  "name": "searchFantomDocs",
  "arguments": { "query": "IOErr" }
}

// 2. Find File reading methods
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "file read",
    "type": "slot"
  }
}

// 3. Look for examples
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "file read error handling",
    "type": "example"
  }
}
```

### Learning Path

**Complete Beginner Flow**:

1. **Get Started**:
   ```json
   { "uri": "workflow://create-pod" }
   ```

2. **Learn Core Types**:
   ```json
   {
     "name": "searchFantomDocs",
     "arguments": {
       "query": "",
       "pod": "sys",
       "type": "type",
       "limit": 20
     }
   }
   ```

3. **See Examples**:
   ```json
   {
     "name": "searchFantomDocs",
     "arguments": {
       "query": "hello world",
       "type": "example"
     }
   }
   ```

4. **Write Tests**:
   ```json
   { "uri": "workflow://unit-testing" }
   ```

5. **Publish Pod**:
   ```json
   { "uri": "workflow://use-fanr" }
   ```

## Performance Tips

### Efficient Searching

**Do**: Use specific queries
```json
{ "query": "HttpClient", "pod": "inet" }
```

**Don't**: Use overly broad queries
```json
{ "query": "network", "limit": 1000 }
```

### Caching Results

If your client makes repeated queries, cache results:

```javascript
const cache = new Map();

async function cachedSearch(query) {
  if (cache.has(query)) {
    return cache.get(query);
  }
  
  const result = await searchFantomDocs(query);
  cache.set(query, result);
  return result;
}
```

### Batch Operations

When exploring a pod, use one query:

**Efficient**:
```json
{
  "name": "searchFantomDocs",
  "arguments": {
    "query": "",
    "pod": "sys",
    "limit": 100
  }
}
```

**Inefficient**:
Multiple separate queries for each type.

## Error Handling

### Handle Missing Results

```javascript
const result = await searchFantomDocs('NonExistentType');

if (result.resultsFound === 0) {
  console.log('No results found. Try a different query.');
  // Suggest alternatives
  const suggestions = await searchFantomDocs('similar term');
}
```

### Handle Server Errors

```javascript
try {
  const result = await client.callTool({
    name: 'searchFantomDocs',
    arguments: { query: 'test' }
  });
} catch (error) {
  if (error.code === 'SERVER_ERROR') {
    console.log('Server error. Try refreshing the index.');
    await client.callTool({
      name: 'refreshIndex',
      arguments: {}
    });
  }
}
```

## Best Practices

1. **Use Qualified Names**: When you know them (e.g., "sys::Str" not just "Str")
2. **Filter by Pod**: Narrows results significantly
3. **Use Type Filters**: Separate types, slots, and examples
4. **Cache Workflow Resources**: They don't change often
5. **Handle Empty Results**: Always check `resultsFound`
6. **Respect Rate Limits**: Don't hammer the server with requests
7. **Use Specific Queries**: Better results than broad searches

---

For more examples and use cases, see the [README.md](README.md) and [workflow guides](workflows/).
