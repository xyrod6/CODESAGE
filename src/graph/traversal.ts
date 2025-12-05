import { storage } from '../storage/index.js';
import { Symbol } from '../parsers/base.js';

export class GraphTraversal {
  async findPath(fromId: string, toId: string): Promise<Symbol[] | null> {
    const visited = new Set<string>();
    const parent = new Map<string, string | null>();
    const distance = new Map<string, number>();

    const queue = [fromId];
    visited.add(fromId);
    parent.set(fromId, null);
    distance.set(fromId, 0);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current === toId) {
        // Reconstruct path
        const path: string[] = [];
        let node: string | null = toId;

        while (node !== null) {
          path.unshift(node);
          node = parent.get(node)!;
        }

        // Convert to symbols and include path metadata
        const symbols: Symbol[] = [];
        for (let i = 0; i < path.length; i++) {
          const symbol = await storage.getSymbol(path[i]);
          if (symbol) {
            // Add path metadata
            (symbol as any).pathIndex = i;
            (symbol as any).pathDistance = distance.get(path[i]);
            symbols.push(symbol);
          }
        }

        return symbols;
      }

      // Get neighbors with priority based on dependency type
      const deps = await storage.getDependenciesFrom(current);

      // Sort dependencies by type priority (imports > extends > implements > calls > uses)
      const typePriority: { [key: string]: number } = {
        'imports': 5,
        'extends': 4,
        'implements': 3,
        'instantiates': 2,
        'calls': 1,
        'uses': 0
      };

      deps.sort((a, b) => (typePriority[b.type] || 0) - (typePriority[a.type] || 0));

      for (const dep of deps) {
        if (!visited.has(dep.to)) {
          visited.add(dep.to);
          parent.set(dep.to, current);
          distance.set(dep.to, (distance.get(current) || 0) + 1);
          queue.push(dep.to);
        }
      }
    }

    return null;
  }

  async findShortestPaths(fromId: string): Promise<Map<string, Symbol[]>> {
    const visited = new Set<string>();
    const parent = new Map<string, string | null>();
    const distance = new Map<string, number>();

    const queue = [fromId];
    visited.add(fromId);
    parent.set(fromId, null);
    distance.set(fromId, 0);

    while (queue.length > 0) {
      const current = queue.shift()!;

      const deps = await storage.getDependenciesFrom(current);
      for (const dep of deps) {
        if (!visited.has(dep.to)) {
          visited.add(dep.to);
          parent.set(dep.to, current);
          distance.set(dep.to, (distance.get(current) || 0) + 1);
          queue.push(dep.to);
        }
      }
    }

    // Build paths to all reachable symbols
    const paths = new Map<string, Symbol[]>();
    for (const targetId of visited) {
      if (targetId === fromId) continue;

      const path: string[] = [];
      let node: string | null = targetId;

      while (node !== null) {
        path.unshift(node);
        node = parent.get(node)!;
      }

      const symbols: Symbol[] = [];
      for (const id of path) {
        const symbol = await storage.getSymbol(id);
        if (symbol) {
          symbols.push(symbol);
        }
      }

      paths.set(targetId, symbols);
    }

    return paths;
  }

  async findCriticalPath(fromId: string, toId: string): Promise<Symbol[] | null> {
    // Use Dijkstra's algorithm with PageRank as edge weights
    const visited = new Set<string>();
    const parent = new Map<string, string | null>();
    const distance = new Map<string, number>();

    // Get PageRank scores for weighting
    const pageRanks = await storage.getPageRanks();

    const queue = [fromId];
    visited.add(fromId);
    parent.set(fromId, null);
    distance.set(fromId, 0);

    while (queue.length > 0) {
      // Sort by distance (priority queue behavior)
      queue.sort((a, b) => (distance.get(a) || 0) - (distance.get(b) || 0));
      const current = queue.shift()!;

      if (current === toId) {
        // Reconstruct path
        const path: string[] = [];
        let node: string | null = toId;

        while (node !== null) {
          path.unshift(node);
          node = parent.get(node)!;
        }

        // Convert to symbols
        const symbols: Symbol[] = [];
        for (const id of path) {
          const symbol = await storage.getSymbol(id);
          if (symbol) {
            symbols.push(symbol);
          }
        }

        return symbols;
      }

      const deps = await storage.getDependenciesFrom(current);
      for (const dep of deps) {
        if (!visited.has(dep.to)) {
          const targetRank = pageRanks.get(dep.to) || 0.001;
          // Lower PageRank means lower cost (prefer less important nodes)
          const edgeCost = 1 / (targetRank * 1000);
          const newDist = (distance.get(current) || 0) + edgeCost;

          if (!distance.has(dep.to) || newDist < distance.get(dep.to)!) {
            visited.add(dep.to);
            parent.set(dep.to, current);
            distance.set(dep.to, newDist);
            queue.push(dep.to);
          }
        }
      }
    }

    return null;
  }

  async getConnectedComponents(): Promise<Symbol[][]> {
    const symbols = await storage.getAllSymbols();
    const visited = new Set<string>();
    const components: Symbol[][] = [];

    for (const symbol of symbols) {
      if (!visited.has(symbol.id)) {
        const component: Symbol[] = [];
        const stack = [symbol.id];

        while (stack.length > 0) {
          const current = stack.pop()!;

          if (visited.has(current)) continue;
          visited.add(current);

          const currentSymbol = await storage.getSymbol(current);
          if (currentSymbol) {
            component.push(currentSymbol);
          }

          // Get all neighbors (both directions)
          const outDeps = await storage.getDependenciesFrom(current);
          const inDeps = await storage.getDependenciesTo(current);

          for (const dep of [...outDeps, ...inDeps]) {
            const neighbor = dep.from === current ? dep.to : dep.from;
            if (!visited.has(neighbor)) {
              stack.push(neighbor);
            }
          }
        }

        if (component.length > 0) {
          components.push(component);
        }
      }
    }

    return components;
  }

  async analyzeImpact(symbolIds: string[]): Promise<{
    directlyAffected: Symbol[];
    transitivelyAffected: Symbol[];
    suggestedOrder: Symbol[];
    highRisk: Symbol[];
    impactSummary: {
      totalAffected: number;
      criticalPaths: string[][];
      affectedFiles: Map<string, number>;
      riskDistribution: { low: number; medium: number; high: number; critical: number };
    };
  }> {
    const directlyAffected: Symbol[] = [];
    const transitivelyAffected = new Map<string, Symbol>();
    const allAffected = new Set<string>(symbolIds);
    const toVisit = [...symbolIds];
    const dependencyPaths = new Map<string, string[][]>();

    // Get PageRank for risk assessment
    const pageRanks = await storage.getPageRanks();

    // BFS to find all affected symbols and track paths
    while (toVisit.length > 0) {
      const current = toVisit.shift()!;
      const dependents = await storage.getDependenciesTo(current);
      const currentPaths = dependencyPaths.get(current) || [[]];

      for (const dep of dependents) {
        if (!allAffected.has(dep.from)) {
          allAffected.add(dep.from);
          toVisit.push(dep.from);

          // Track paths to this symbol
          const newPaths = currentPaths.map(path => [...path, dep.from]);
          dependencyPaths.set(dep.from, newPaths);

          const symbol = await storage.getSymbol(dep.from);
          if (symbol) {
            if (dependents.length > 0) {
              directlyAffected.push(symbol);
            } else {
              transitivelyAffected.set(dep.from, symbol);
            }
          }
        }
      }
    }

    // Calculate high-risk symbols with sophisticated risk assessment
    const highRisk: Symbol[] = [];
    const riskBySymbol = new Map<string, { risk: number; factors: string[] }>();

    for (const id of allAffected) {
      const rank = pageRanks.get(id) || 0;
      const symbol = await storage.getSymbol(id);
      if (!symbol) continue;

      const factors: string[] = [];
      let riskScore = rank * 100;

      // High PageRank
      if (rank > 0.01) {
        factors.push(`High PageRank (${rank.toFixed(4)})`);
        riskScore += rank * 200;
      }

      // Entry point
      const filename = symbol.filepath.split('/').pop() || '';
      if (filename === 'index.ts' || filename === 'main.ts') {
        factors.push('Entry point file');
        riskScore += 50;
      }

      // Exported symbol
      if (symbol.exported) {
        factors.push('Exported symbol');
        riskScore += 30;
      }

      // Many dependents
      const dependentCount = (await storage.getDependenciesTo(id)).length;
      if (dependentCount > 5) {
        factors.push(`${dependentCount} dependents`);
        riskScore += dependentCount * 5;
      }

      // Critical path through symbol
      const paths = dependencyPaths.get(id) || [];
      if (paths.length > 10) {
        factors.push(`${paths.length} impact paths`);
        riskScore += paths.length * 2;
      }

      riskBySymbol.set(id, { risk: riskScore, factors });
    }

    // Categorize risk levels
    const riskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const [id, { risk }] of riskBySymbol) {
      if (risk > 100) {
        riskDistribution.critical++;
        const symbol = await storage.getSymbol(id);
        if (symbol) highRisk.push(symbol);
      } else if (risk > 50) {
        riskDistribution.high++;
        const symbol = await storage.getSymbol(id);
        if (symbol) highRisk.push(symbol);
      } else if (risk > 20) {
        riskDistribution.medium++;
      } else {
        riskDistribution.low++;
      }
    }

    // Sort high-risk by risk score
    highRisk.sort((a, b) => {
      const riskA = riskBySymbol.get(a.id)?.risk || 0;
      const riskB = riskBySymbol.get(b.id)?.risk || 0;
      return riskB - riskA;
    });

    // Suggest order based on dependency graph (topological sort)
    const suggestedOrder = await this.topologicalSort(Array.from(allAffected));

    // Group affected by file
    const affectedFiles = new Map<string, number>();
    for (const id of allAffected) {
      const symbol = await storage.getSymbol(id);
      if (symbol) {
        const count = affectedFiles.get(symbol.filepath) || 0;
        affectedFiles.set(symbol.filepath, count + 1);
      }
    }

    // Identify critical paths (longest dependency chains)
    const criticalPaths: string[][] = [];
    for (const [id, paths] of dependencyPaths) {
      if (paths.length > 0) {
        const longestPath = paths.reduce((a, b) => a.length > b.length ? a : b);
        if (longestPath.length > 3) {
          criticalPaths.push(longestPath);
        }
      }
    }

    return {
      directlyAffected,
      transitivelyAffected: Array.from(transitivelyAffected.values()),
      suggestedOrder,
      highRisk,
      impactSummary: {
        totalAffected: allAffected.size,
        criticalPaths,
        affectedFiles,
        riskDistribution,
      },
    };
  }

  private async topologicalSort(nodeIds: string[]): Promise<Symbol[]> {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    // Initialize
    for (const id of nodeIds) {
      inDegree.set(id, 0);
      adjList.set(id, []);
    }

    // Build graph
    for (const id of nodeIds) {
      const deps = await storage.getDependenciesFrom(id);
      for (const dep of deps) {
        if (nodeIds.includes(dep.to)) {
          adjList.get(id)!.push(dep.to);
          inDegree.set(dep.to, (inDegree.get(dep.to) || 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      for (const neighbor of adjList.get(current) || []) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // Convert to symbols
    const symbols: Symbol[] = [];
    for (const id of result) {
      const symbol = await storage.getSymbol(id);
      if (symbol) {
        symbols.push(symbol);
      }
    }

    return symbols;
  }

  async findSimilar(targetSymbol: Symbol, limit: number = 5): Promise<{ symbol: Symbol; relevanceScore: number; reason: string }[]> {
    const allSymbols = await storage.getAllSymbols();
    const candidates: { symbol: Symbol; relevanceScore: number; reason: string }[] = [];

    for (const symbol of allSymbols) {
      if (symbol.id === targetSymbol.id) continue;

      let score = 0;
      const reasons: string[] = [];

      // Same kind
      if (symbol.kind === targetSymbol.kind) {
        score += 0.3;
        reasons.push(`Same kind: ${symbol.kind}`);
      }

      // Same language
      if (symbol.language === targetSymbol.language) {
        score += 0.2;
        reasons.push(`Same language: ${symbol.language}`);
      }

      // Similar name
      const nameSimilarity = this.calculateNameSimilarity(targetSymbol.name, symbol.name);
      if (nameSimilarity > 0.5) {
        score += nameSimilarity * 0.3;
        reasons.push(`Similar name: ${Math.round(nameSimilarity * 100)}%`);
      }

      // Same file structure
      if (symbol.filepath === targetSymbol.filepath) {
        score += 0.2;
        reasons.push('Same file');
      }

      if (score > 0.3) {
        candidates.push({
          symbol,
          relevanceScore: score,
          reason: reasons.join(', '),
        });
      }
    }

    // Sort by score and limit
    candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return candidates.slice(0, limit);
  }

  private calculateNameSimilarity(a: string, b: string): number {
    // Simple Levenshtein distance approximation
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    if (longer.length === 0) return 1;

    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  async findCycles(): Promise<Symbol[][]> {
    const symbols = await storage.getAllSymbols();
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const parent = new Map<string, string>();
    const cycles: Symbol[][] = [];

    const dfs = async (nodeId: string): Promise<boolean> => {
      visited.add(nodeId);
      recStack.add(nodeId);

      const deps = await storage.getDependenciesFrom(nodeId);
      for (const dep of deps) {
        if (!visited.has(dep.to)) {
          parent.set(dep.to, nodeId);
          if (await dfs(dep.to)) {
            return true;
          }
        } else if (recStack.has(dep.to)) {
          // Found a cycle, reconstruct it
          const cycle: string[] = [];
          let current = nodeId;

          cycle.push(dep.to); // Start with the node that created the cycle
          cycle.push(current);

          while (current && current !== dep.to) {
            current = parent.get(current) || '';
            if (current) {
              cycle.push(current);
            }
          }

          // Convert to symbols
          const cycleSymbols: Symbol[] = [];
          for (const id of cycle) {
            const symbol = await storage.getSymbol(id);
            if (symbol) {
              cycleSymbols.push(symbol);
            }
          }

          cycles.push(cycleSymbols);
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    for (const symbol of symbols) {
      if (!visited.has(symbol.id)) {
        await dfs(symbol.id);
      }
    }

    return cycles;
  }

  async findBottlenecks(): Promise<{ symbol: Symbol; incoming: number; outgoing: number; score: number }[]> {
    const symbols = await storage.getAllSymbols();
    const bottlenecks: { symbol: Symbol; incoming: number; outgoing: number; score: number }[] = [];

    for (const symbol of symbols) {
      const incoming = (await storage.getDependenciesTo(symbol.id)).length;
      const outgoing = (await storage.getDependenciesFrom(symbol.id)).length;

      // Bottleneck score: combination of incoming and outgoing edges
      // High incoming + high outgoing = potential bottleneck
      const score = Math.sqrt(incoming * outgoing);

      if (score > 4) { // Threshold for bottleneck
        bottlenecks.push({
          symbol,
          incoming,
          outgoing,
          score,
        });
      }
    }

    // Sort by bottleneck score
    bottlenecks.sort((a, b) => b.score - a.score);

    return bottlenecks;
  }

  async findDeadCode(): Promise<Symbol[]> {
    const symbols = await storage.getAllSymbols();
    const pageRanks = await storage.getPageRanks();
    const deadCode: Symbol[] = [];

    for (const symbol of symbols) {
      // Skip entry points and exported symbols
      const filename = symbol.filepath.split('/').pop() || '';
      if (filename === 'index.ts' || filename === 'main.ts' || symbol.exported) {
        continue;
      }

      const rank = pageRanks.get(symbol.id) || 0;
      const dependents = await storage.getDependenciesTo(symbol.id);

      // Criteria for dead code:
      // - Very low PageRank
      // - No dependents
      // - Not an entry point
      // - Not exported
      if (rank < 0.0001 && dependents.length === 0) {
        deadCode.push(symbol);
      }
    }

    return deadCode;
  }
}