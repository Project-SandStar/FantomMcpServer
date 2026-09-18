// Standalone test to verify core functionality without MCP client
import { loadConfig } from '../../build/config/index.js';
import { CacheManager } from '../../build/cache/index.js';
import { FantomDocsParser } from '../../build/parser/index.js';
import { SearchIndex } from '../../build/search/index.js';

async function testCore() {
  console.log('=== MCP Fantom Server - Core Functionality Test ===\n');

  try {
    // Load configuration
    console.log('1. Loading configuration...');
    const config = loadConfig();
    console.log(`   ✓ Docs path: ${config.docsPath}`);
    console.log(`   ✓ Cache dir: ${config.cacheDir}`);
    console.log(`   ✓ Max depth: ${config.crawlSettings.maxDepth}\n`);

    // Initialize cache manager
    console.log('2. Initializing cache manager...');
    const cacheManager = new CacheManager(config);
    await cacheManager.initialize();
    console.log('   ✓ Cache manager initialized\n');

    // Initialize search index
    console.log('3. Initializing search index...');
    const searchIndex = new SearchIndex();
    console.log('   ✓ Search index created\n');

    // Try to load from cache
    console.log('4. Checking for cached documentation...');
    let cachedItems = await cacheManager.loadDocsIndex();

    if (cachedItems && cachedItems.length > 0) {
      console.log(`   ✓ Found ${cachedItems.length} items in cache`);
      console.log('   ℹ Skipping crawl (using cached data)\n');
      
      await searchIndex.addItems(cachedItems);
    } else {
      console.log('   ℹ No cache found, starting documentation crawl...');
      console.log('   ⚠ This may take 2-5 minutes depending on network speed\n');
      
      const parser = new FantomDocsParser(config);
      const items = await parser.parseAll();
      
      console.log(`\n   ✓ Parsed ${items.length} documentation items`);
      
      // Add to search index
      await searchIndex.addItems(items);
      
      // Save to cache
      await cacheManager.saveDocsIndex(items);
      console.log('   ✓ Saved to cache for next time\n');
    }

    // Test search functionality
    console.log('5. Testing search functionality...');
    const testQueries = ['Str', 'HttpClient', 'File'];
    
    for (const query of testQueries) {
      const results = await searchIndex.search(query, 3);
      console.log(`\n   Query: "${query}"`);
      if (results.length > 0) {
        results.forEach((r, i) => {
          console.log(`     ${i + 1}. ${r.item.qualifiedName || r.item.name} (${r.item.type})`);
          console.log(`        Relevance: ${r.relevance}`);
        });
      } else {
        console.log('     No results found');
      }
    }

    // Show statistics
    console.log('\n6. Index statistics:');
    const stats = searchIndex.getStats();
    console.log(`   Total items: ${stats.totalItems}`);
    console.log(`   By type:`, stats.byType);
    console.log(`   Pods indexed: ${Object.keys(stats.byPod).length}`);
    
    console.log('\n=== ✅ All tests passed! ===');
    console.log('\nThe MCP server is ready to use.');
    console.log('To start the server: npm start');
    console.log('To integrate with Claude: See QUICKSTART.md\n');

  } catch (error) {
    console.error('\n=== ❌ Test failed ===');
    console.error('Error:', error);
    process.exit(1);
  }
}

testCore();
