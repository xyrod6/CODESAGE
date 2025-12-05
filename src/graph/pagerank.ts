import { storage } from '../storage/index.js';
import { Symbol } from '../parsers/base.js';
import { config } from '../config.js';

export class PageRankCalculator {
  async calculate(): Promise<Map<string, number>> {
    const symbols = await storage.getAllSymbols();
    const dependencies = await storage.getAllDependencies();

    // Build adjacency list
    const graph = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const symbol of symbols) {
      graph.set(symbol.id, new Set());
      inDegree.set(symbol.id, 0);
    }

    // Build edges
    for (const dep of dependencies) {
      if (graph.has(dep.from) && graph.has(dep.to)) {
        graph.get(dep.from)!.add(dep.to);
        inDegree.set(dep.to, (inDegree.get(dep.to) || 0) + 1);
      }
    }

    // PageRank algorithm
    const damping = config.pagerank.damping;
    const iterations = config.pagerank.iterations;
    const tolerance = config.pagerank.tolerance;

    const n = symbols.length;
    const rank = new Map<string, number>();
    const baseRank = 1 / n;

    // Initialize ranks with base values
    for (const symbol of symbols) {
      // Exported symbols get 1.5x base score
      let multiplier = symbol.exported ? 1.5 : 1;

      // Entry points get 2x
      const filepath = symbol.filepath.toLowerCase();
      if (
        filepath.endsWith('index.ts') ||
        filepath.endsWith('main.ts') ||
        filepath.endsWith('index.js') ||
        filepath.endsWith('main.js') ||
        filepath.includes('/bin/') ||
        filepath.includes('/src/main/')
      ) {
        multiplier *= 2;
      }

      // Classes weighted higher than functions
      if (symbol.kind === 'class' || symbol.kind === 'interface') {
        multiplier *= 1.2;
      } else if (symbol.kind === 'function' || symbol.kind === 'method') {
        multiplier *= 1.1;
      }

      rank.set(symbol.id, baseRank * multiplier);
    }

    // Iterate
    for (let iter = 0; iter < iterations; iter++) {
      const newRank = new Map<string, number>();

      for (const symbol of symbols) {
        let sum = 0;

        // Sum incoming ranks
        for (const [from, toSet] of graph.entries()) {
          if (toSet.has(symbol.id)) {
            const fromRank = rank.get(from) || 0;
            const outDegree = toSet.size;
            if (outDegree > 0) {
              sum += fromRank / outDegree;
            }
          }
        }

        const pageRank = (1 - damping) / n + damping * sum;
        newRank.set(symbol.id, pageRank);
      }

      // Check convergence
      let converged = true;
      for (const [id, r] of rank.entries()) {
        const diff = Math.abs((r || 0) - (newRank.get(id) || 0));
        if (diff > tolerance) {
          converged = false;
          break;
        }
      }

      rank.clear();
      for (const [id, r] of newRank.entries()) {
        rank.set(id, r);
      }

      if (converged) break;
    }

    // Store PageRank scores
    await storage.setPageRanks(rank);

    return rank;
  }

  async getTopSymbols(count: number = 50): Promise<{ symbol: Symbol; score: number }[]> {
    const ranks = await storage.getPageRanks();
    const sorted = Array.from(ranks.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, count);

    const results: { symbol: Symbol; score: number }[] = [];

    for (const [id, score] of sorted) {
      const symbol = await storage.getSymbol(id);
      if (symbol) {
        results.push({ symbol, score });
      }
    }

    return results;
  }
}