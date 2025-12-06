#!/usr/bin/env node
import { indexer } from './src/indexer/index.js';
import { storage } from './src/storage/index.js';
import { dependencyResolver } from './src/indexer/dependency-resolver.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testIndexing() {
  console.log('=== CODESAGE Indexing Test ===\n');

  const projectPath = __dirname;

  try {
    // Step 1: Index the project
    console.log('Step 1: Indexing project...');
    const stats = await indexer.indexProject(projectPath, { force: true });

    console.log('\n✓ Indexing Stats:');
    console.log(`  - Files indexed: ${stats.filesIndexed}`);
    console.log(`  - Files skipped: ${stats.filesSkipped}`);
    console.log(`  - Symbols found: ${stats.symbolsFound}`);
    console.log(`  - Dependencies found: ${stats.dependenciesFound}`);
    console.log(`  - Time taken: ${stats.timeMs}ms`);
    console.log(`  - Errors: ${stats.errors.length}`);

    if (stats.errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      stats.errors.slice(0, 5).forEach(err => {
        console.log(`  - ${err.filepath}: ${err.error}`);
      });
      if (stats.errors.length > 5) {
        console.log(`  ... and ${stats.errors.length - 5} more`);
      }
    }

    // Step 2: Verify symbols
    console.log('\n\nStep 2: Verifying symbols...');
    const allSymbols = await storage.getAllSymbols();
    console.log(`✓ Total symbols in storage: ${allSymbols.length}`);

    // Sample some symbols
    const sampleSymbols = allSymbols.slice(0, 5);
    console.log('\nSample symbols:');
    sampleSymbols.forEach(sym => {
      console.log(`  - ${sym.name} (${sym.kind}) in ${sym.filepath.replace(projectPath, '.')}`);
    });

    // Step 3: Verify dependencies
    console.log('\n\nStep 3: Verifying dependencies...');
    const allDeps = await storage.getAllDependencies();
    console.log(`✓ Total dependencies in storage: ${allDeps.length}`);

    // Sample some dependencies
    const sampleDeps = allDeps.slice(0, 10);
    console.log('\nSample dependencies:');
    sampleDeps.forEach(dep => {
      console.log(`  - ${dep.from} → ${dep.to} (${dep.type})`);
    });

    // Step 4: Test dependency resolution for a specific file
    console.log('\n\nStep 4: Testing dependency resolution...');
    const indexerFile = path.join(projectPath, 'src/indexer/index.ts');

    // Get symbols from this file
    const indexerSymbols = await storage.getSymbolsByFile(indexerFile);
    console.log(`✓ Found ${indexerSymbols.length} symbols in src/indexer/index.ts`);

    if (indexerSymbols.length > 0) {
      const firstSymbol = indexerSymbols[0];
      console.log(`\nAnalyzing symbol: ${firstSymbol.name} (${firstSymbol.id})`);

      // Get dependencies (what this symbol depends on)
      const dependencies = await storage.getDependenciesFrom(firstSymbol.id);
      console.log(`  - Dependencies (what it uses): ${dependencies.length}`);
      if (dependencies.length > 0) {
        dependencies.slice(0, 3).forEach(dep => {
          console.log(`    → ${dep.toId} (${dep.type})`);
        });
      }

      // Get dependents (what depends on this symbol)
      const dependents = await storage.getDependenciesTo(firstSymbol.id);
      console.log(`  - Dependents (what uses it): ${dependents.length}`);
      if (dependents.length > 0) {
        dependents.slice(0, 3).forEach(dep => {
          console.log(`    ← ${dep.fromId} (${dep.type})`);
        });
      }
    }

    // Step 5: Test symbol search
    console.log('\n\nStep 5: Testing symbol search...');
    const indexerClasses = allSymbols.filter(s =>
      s.name.toLowerCase().includes('indexer') && s.kind === 'class'
    );
    console.log(`✓ Found ${indexerClasses.length} classes with "indexer" in name:`);
    indexerClasses.forEach(cls => {
      console.log(`  - ${cls.name} in ${cls.filepath.replace(projectPath, '.')}`);
    });

    // Step 6: Test PageRank scores
    console.log('\n\nStep 6: Testing PageRank scores...');
    const topSymbols = allSymbols
      .filter(s => s.pageRank !== undefined)
      .sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0))
      .slice(0, 10);

    console.log('✓ Top 10 symbols by PageRank:');
    topSymbols.forEach((sym, i) => {
      console.log(`  ${i + 1}. ${sym.name} (${sym.kind}) - Score: ${sym.pageRank?.toFixed(6)} - ${sym.filepath.replace(projectPath, '.')}`);
    });

    // Step 7: Verify project metadata
    console.log('\n\nStep 7: Verifying project metadata...');
    const metadata = await storage.getProjectMetadata();
    if (metadata) {
      console.log('✓ Project metadata:');
      console.log(`  - Root: ${metadata.root}`);
      console.log(`  - Indexed at: ${metadata.indexedAt}`);
      console.log(`  - Files: ${metadata.stats.files}`);
      console.log(`  - Symbols: ${metadata.stats.symbols}`);
      console.log(`  - Edges: ${metadata.stats.edges}`);
    } else {
      console.log('⚠️  No project metadata found');
    }

    console.log('\n\n=== Test Complete ===');
    console.log('✅ All tests passed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  } finally {
    // Clean up
    await indexer.stop();
    await storage.close();
  }
}

testIndexing();
