#!/usr/bin/env node
import { storage } from './src/storage/index.js';
import { indexer } from './src/indexer/index.js';

async function detailedTest() {
  console.log('=== Detailed Diagnostic Test ===\n');

  try {
    // Check PageRank storage
    console.log('1. Checking PageRank scores...');
    const pageRanks = await storage.getPageRanks();
    console.log(`   Found ${pageRanks.size} PageRank scores`);

    if (pageRanks.size > 0) {
      const topRanks = Array.from(pageRanks.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      console.log('   Top 5 by PageRank:');
      for (const [id, score] of topRanks) {
        console.log(`     - ${id}: ${score.toFixed(6)}`);
        // Get the symbol to see if it has the pageRank field
        const symbol = await storage.getSymbol(id);
        if (symbol) {
          console.log(`       Symbol pageRank field: ${symbol.pageRank || 'NOT SET'}`);
        }
      }
    }

    // Check dependency structure
    console.log('\n2. Checking dependency structure...');
    const allDeps = await storage.getAllDependencies();
    console.log(`   Found ${allDeps.length} dependencies`);

    if (allDeps.length > 0) {
      const sample = allDeps[0];
      console.log('   Sample dependency structure:');
      console.log(`     - from field: ${sample.from}`);
      console.log(`     - to field: ${sample.to}`);
      console.log(`     - type: ${sample.type}`);
      console.log(`     - Keys: ${Object.keys(sample).join(', ')}`);
    }

    // Check cross-file imports
    console.log('\n3. Checking cross-file imports...');
    const importDeps = allDeps.filter(d => d.type === 'imports');
    console.log(`   Found ${importDeps.length} import dependencies`);

    if (importDeps.length > 0) {
      console.log('   Sample imports:');
      for (const dep of importDeps.slice(0, 3)) {
        const fromSymbol = await storage.getSymbol(dep.from);
        const toSymbol = await storage.getSymbol(dep.to);
        console.log(`     - ${fromSymbol?.name || dep.from} → ${toSymbol?.name || dep.to}`);
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await indexer.stop();
    await storage.close();
  }
}

detailedTest();
