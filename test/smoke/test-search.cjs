// Simple test script for documentation search
const { loadConfig } = require('../../build/config/index.js');
const { SearchIndex } = require('../../build/search/index.js');
const { CacheManager } = require('../../build/cache/index.js');

async function main() {
  console.log('Testing documentation search...\n');

  try {
    const config = loadConfig();
    const cacheManager = new CacheManager(config);
    const searchIndex = new SearchIndex();

    // Initialize cache
    await cacheManager.initialize();

    // Load cached docs
    const cachedItems = await cacheManager.loadDocsIndex();
    
    if (!cachedItems || cachedItems.length === 0) {
      console.log('No cached documentation found. Run `npm run dev` first to index documentation.');
      process.exit(1);
    }

    console.log(`Loaded ${cachedItems.length} documentation items from cache\n`);

    // Add items to search index
    await searchIndex.addItems(cachedItems);

    // Test searches
    const queries = ['Str', 'sys::Int', 'HttpClient', 'File', 'concurrent'];

    for (const query of queries) {
      console.log(`\n--- Searching for: "${query}" ---`);
      const results = await searchIndex.search(query, 5);

      if (results.length === 0) {
        console.log('No results found');
      } else {
        results.forEach((result, i) => {
          console.log(`${i + 1}. ${result.item.name} (${result.item.type})`);
          console.log(`   ${result.item.qualifiedName || 'N/A'}`);
          console.log(`   Relevance: ${result.relevance} (${result.score.toFixed(2)})`);
          console.log(`   URL: ${result.item.url}`);
        });
      }
    }

    // Show statistics
    console.log('\n--- Index Statistics ---');
    const stats = searchIndex.getStats();
    console.log(`Total items: ${stats.totalItems}`);
    console.log('By type:', stats.byType);
    console.log('By pod:', stats.byPod);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
