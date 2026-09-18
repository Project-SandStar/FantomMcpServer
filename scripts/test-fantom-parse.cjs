const { execSync } = require('child_process');
const path = require('path');

// Test code from the complex grammar test
const fantomCode = `using concurrent

const class ComponentCache
{
  private const Int maxPerDevice := 500
  private const AtomicRef cacheRef := AtomicRef(Str:Str:CachedComp[:].toImmutable)

  static ComponentCache instance()
  {
    inst := instanceRef.val as ComponentCache
    return inst
  }

  Void each(|CachedComp val, Str key| f)
  {
    data.each(f)
  }
}`;

async function main() {
  // Dynamic import for ES module
  const { TreeSitterParser } = await import('../build/parser/treeSitter/treeSitterParser.js');

  const parser = new TreeSitterParser();
  await parser.initialize();

  console.log('Parsing Fantom code...\n');
  console.log('=== SOURCE CODE ===');
  console.log(fantomCode);
  console.log('\n=== PARSE RESULT ===');

  const result = await parser.parseSource(fantomCode, 'fantom');

  console.log('Errors:', result.errors.length);
  if (result.errors.length > 0) {
    console.log('\nParse Errors:');
    result.errors.forEach((err, i) => {
      console.log(`  ${i + 1}. ${err.message} at line ${err.line}, col ${err.column}`);
    });
  }

  console.log('\nClasses found:', result.classes.length);
  result.classes.forEach(cls => {
    console.log(`  - ${cls.name}`);
    if (cls.methods) {
      cls.methods.forEach(m => console.log(`      method: ${m.name}()`));
    }
    if (cls.fields) {
      cls.fields.forEach(f => console.log(`      field: ${f.name}`));
    }
  });

  console.log('\nFunctions found:', result.functions.length);
  result.functions.forEach(fn => {
    console.log(`  - ${fn.name}()`);
  });
}

main().catch(console.error);
