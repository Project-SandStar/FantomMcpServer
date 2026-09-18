// Test cache loading
const { loadConfig } = require('../../build/config/index.js');
const { CacheManager } = require('../../build/cache/index.js');

async function main() {
  console.log('Testing cache system...\n');

  try {
    const config = loadConfig();
    console.log('Configuration loaded:', {
      docsPath: config.docsPath,
      codePath: config.codePath,
      cacheDir: config.cacheDir,
    });

    const cacheManager = new CacheManager(config);
    await cacheManager.initialize();

    console.log('\nAttempting to load documentation cache...');
    const docsCache = await cacheManager.loadDocsIndex();

    if (docsCache) {
      console.log(`✓ Found documentation cache with ${docsCache.length} items`);
      
      // Show sample items
      console.log('\nSample items:');
      docsCache.slice(0, 5).forEach((item, i) => {
        console.log(`${i + 1}. ${item.name} (${item.type})`);
        console.log(`   ${item.qualifiedName || 'N/A'}`);
      });
    } else {
      console.log('✗ No documentation cache found');
      console.log('Run the server first to build the cache.');
    }

    console.log('\nAttempting to load code cache...');
    const codeCache = await cacheManager.loadCodeIndex();

    if (codeCache) {
      console.log(`✓ Found code cache with ${codeCache.length} items`);
    } else {
      console.log('✗ No code cache found (expected for Milestone 1)');
    }

    // Get metadata
    console.log('\n--- Cache Metadata ---');
    const docsMeta = await cacheManager.getCacheMetadata('docs');
    if (docsMeta) {
      console.log('Documentation cache:');
      console.log(`  Version: ${docsMeta.version}`);
      console.log(`  Timestamp: ${new Date(docsMeta.timestamp).toISOString()}`);
      console.log(`  Items: ${docsMeta.itemCount}`);
      console.log(`  Source: ${docsMeta.source}`);
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
