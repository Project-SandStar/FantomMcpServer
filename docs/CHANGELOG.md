# Changelog

All notable changes to the MCP Fantom Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-11-03

### Added - Milestone 1: Documentation Indexing

#### Core Features
- **Documentation Crawler**: Intelligent HTML parser that crawls fantom.org documentation
  - Extracts type definitions (class, mixin, enum)
  - Captures slot information (methods, fields) with signatures
  - Collects code examples from documentation
  - Respects crawl depth limits and delays
  
- **FlexSearch Integration**: Fast, fuzzy search across all indexed content
  - Full-text search with contextual ranking
  - Multi-field indexing (name, qualified name, description, signature, keywords)
  - Relevance scoring with exact match boosting
  - Support for filtering by type and pod
  
- **Cache System**: Persistent storage for indexed documentation
  - JSON-based cache in `.cache/flexsearch-fantom.json`
  - Version control for cache invalidation
  - Metadata tracking (timestamp, item count, source)
  - Configurable enable/disable
  
#### MCP Tools
- `searchFantomDocs`: Search documentation with filters
  - Query parameter for search terms
  - Optional type filter (type, slot, example, guide)
  - Optional pod filter
  - Configurable result limit
  
- `getFantomType`: Retrieve detailed type information
  - Qualified name lookup
  - Related slots enumeration
  - Full type metadata
  
- `listFantomPods`: List all indexed pods with item counts

- `refreshIndex`: Force re-indexing of documentation
  - Clears existing cache
  - Re-crawls documentation
  - Rebuilds search index

#### MCP Resources
- `workflow://create-pod`: Complete guide for creating Fantom pods
- `workflow://use-fanr`: Comprehensive fanr usage guide
- `workflow://haxall-basics`: Introduction to Haxall development
- `workflow://unit-testing`: Unit testing best practices for Fantom

#### Configuration
- JSON-based configuration file (`fantom-config.json`)
- Environment variable support via `.env`
- Configurable crawl settings:
  - Maximum depth
  - Delay between requests
  - Request timeout
- Search configuration:
  - Maximum results
  - Minimum relevance score

#### Developer Tools
- Test script for search functionality (`test-search.cjs`)
- Test script for cache verification (`test-cache.cjs`)
- Test script for parser validation (`test-parse-docs.cjs`)
- Comprehensive logging with debug mode
- Build scripts with workflow copying

#### Documentation
- Comprehensive README with installation and usage
- Quick start guide for rapid setup
- Detailed workflow guides (4 guides)
- Troubleshooting section
- API documentation for MCP tools

#### Project Structure
- TypeScript-based implementation
- Modular architecture:
  - Config management
  - Documentation parser
  - Search index
  - Cache manager
  - Utilities
- Full type definitions
- ES Modules support

### Technical Details

#### Dependencies
- `@modelcontextprotocol/sdk`: ^0.5.0
- `cheerio`: ^1.0.0 (HTML parsing)
- `flexsearch`: ^0.7.43 (search indexing)
- `node-fetch`: ^3.3.2 (HTTP requests)
- `fs-extra`: ^11.2.0 (file operations)
- `node-cache`: ^5.1.2 (in-memory caching)
- `dotenv`: ^16.4.5 (environment variables)

#### Build System
- TypeScript 5.4.3
- ES2022 target
- Source maps enabled
- Strict type checking

#### Testing
- Jest test framework configured
- Manual test scripts for development
- Integration test support

## [Unreleased]

### Planned for Milestone 2: Code Indexing
- [ ] `.fan` file parser
- [ ] Local code indexing
- [ ] Class and method extraction
- [ ] `searchFantomCode` MCP tool

### Planned for Milestone 3: Combined Search
- [ ] Merged documentation and code search
- [ ] Semantic relevance ranking
- [ ] `findFantomExamples` MCP tool

### Planned for Milestone 4: Validation & Execution
- [ ] `fan -check` integration
- [ ] Syntax validation tool
- [ ] Code execution sandbox
- [ ] `evalFantom` MCP tool

### Planned for Milestone 5: Workflows
- [ ] Additional workflow guides
- [ ] Interactive examples
- [ ] Best practices documentation
- [ ] Advanced Haxall patterns

---

## Version History

- **0.1.0** (2025-11-03): Initial release with documentation indexing (Milestone 1)
