#!/usr/bin/env node
import { storage } from './src/storage/index.js';
import { SymbolExtractor } from './src/indexer/symbol-extractor.js';

async function testImports() {
  console.log('=== Import Dependency Test ===\n');

  try {
    // Test on a simple file with known imports
    const testFile = './src/indexer/index.ts';
    const extractor = new SymbolExtractor();

    console.log(`1. Extracting from ${testFile}...`);
    const result = await extractor.extractBatch([testFile], {
      includeDependencies: true,
      deduplicateSymbols: false,
    });

    console.log(`   Symbols found: ${result.symbols.length}`);
    console.log(`   Raw dependencies found: ${result.dependencies.length}`);

    // Show import dependencies
    const importDeps = result.dependencies.filter(d => d.type === 'imports');
    console.log(`   Import dependencies: ${importDeps.length}`);

    if (importDeps.length > 0) {
      console.log('\n   Sample imports:');
      importDeps.slice(0, 10).forEach(dep => {
        console.log(`     - from: ${dep.from}`);
        console.log(`       to: ${dep.to}`);
        console.log(`       type: ${dep.type}`);
        console.log('');
      });
    } else {
      console.log('\n   ⚠️  No import dependencies found!');
      console.log('   Let me check what dependencies were found:');
      result.dependencies.slice(0, 5).forEach(dep => {
        console.log(`     - from: ${dep.from}`);
        console.log(`       to: ${dep.to}`);
        console.log(`       type: ${dep.type}`);
        console.log('');
      });
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await storage.close();
  }
}

testImports();
