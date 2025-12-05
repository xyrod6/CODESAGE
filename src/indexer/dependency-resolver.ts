import { storage } from '../storage/index.js';
import { Symbol, DependencyEdge } from '../parsers/base.js';
import { config } from '../config.js';

export class DependencyResolver {
  async resolveDependencies(symbols: Symbol[]): Promise<DependencyEdge[]> {
    const dependencies: DependencyEdge[] = [];

    // Group symbols by file for efficient processing
    const symbolsByFile = new Map<string, Symbol[]>();
    for (const symbol of symbols) {
      if (!symbolsByFile.has(symbol.filepath)) {
        symbolsByFile.set(symbol.filepath, []);
      }
      symbolsByFile.get(symbol.filepath)!.push(symbol);
    }

    // Resolve dependencies for each symbol
    for (const symbol of symbols) {
      const symbolDeps = await this.resolveSymbolDependencies(symbol, symbolsByFile);
      dependencies.push(...symbolDeps);
    }

    return dependencies;
  }

  async resolveSymbolDependencies(symbol: Symbol, symbolsByFile?: Map<string, Symbol[]>): Promise<DependencyEdge[]> {
    const dependencies: DependencyEdge[] = [];

    // Get symbols by file map if not provided
    if (!symbolsByFile) {
      const allSymbols = await storage.getAllSymbols();
      symbolsByFile = new Map<string, Symbol[]>();
      for (const s of allSymbols) {
        if (!symbolsByFile.has(s.filepath)) {
          symbolsByFile.set(s.filepath, []);
        }
        symbolsByFile.get(s.filepath)!.push(s);
      }
    }

    // Check for import dependencies at file level
    const importDeps = await this.resolveImportDependencies(symbol, symbolsByFile);
    dependencies.push(...importDeps);

    // Check for symbol-to-symbol dependencies within the same file
    const fileSymbols = symbolsByFile.get(symbol.filepath) || [];
    for (const otherSymbol of fileSymbols) {
      if (otherSymbol.id === symbol.id) continue;

      // Check for various dependency types
      const depType = this.determineDependencyType(symbol, otherSymbol);
      if (depType) {
        dependencies.push({
          from: symbol.id,
          to: otherSymbol.id,
          type: depType,
          location: symbol.location,
        });
      }
    }

    return dependencies;
  }

  private async resolveImportDependencies(symbol: Symbol, symbolsByFile: Map<string, Symbol[]>): Promise<DependencyEdge[]> {
    const dependencies: DependencyEdge[] = [];

    // For classes and interfaces, check for extends/implements relationships
    if (symbol.signature) {
      // Look for extends patterns
      const extendsMatch = symbol.signature.match(/extends\s+(\w+)/);
      if (extendsMatch) {
        const parentName = extendsMatch[1];
        const parentSymbols = await this.findSymbolsByName(parentName, symbolsByFile);
        for (const parent of parentSymbols) {
          dependencies.push({
            from: symbol.id,
            to: parent.id,
            type: 'extends',
            location: symbol.location,
          });
        }
      }

      // Look for implements patterns
      const implementsMatch = symbol.signature.match(/implements\s+([\w,\s]+)/);
      if (implementsMatch) {
        const interfaces = implementsMatch[1].split(',').map(s => s.trim());
        for (const ifaceName of interfaces) {
          const ifaceSymbols = await this.findSymbolsByName(ifaceName, symbolsByFile);
          for (const iface of ifaceSymbols) {
            dependencies.push({
              from: symbol.id,
              to: iface.id,
              type: 'implements',
              location: symbol.location,
            });
          }
        }
      }
    }

    return dependencies;
  }

  private async findSymbolsByName(name: string, symbolsByFile: Map<string, Symbol[]>): Promise<Symbol[]> {
    const results: Symbol[] = [];

    // Search in all files for the symbol
    for (const symbols of symbolsByFile.values()) {
      for (const symbol of symbols) {
        if (symbol.name === name) {
          results.push(symbol);
        }
      }
    }

    return results;
  }

  private determineDependencyType(from: Symbol, to: Symbol): DependencyEdge['type'] | null {
    // Check if 'from' instantiates 'to' (new ClassName())
    if (from.signature && from.signature.includes(`new ${to.name}(`)) {
      return 'instantiates';
    }

    // Check if 'from' calls 'to' (function call)
    if (from.signature && from.signature.includes(`${to.name}(`)) {
      return 'calls';
    }

    // Check if 'from' uses 'to' (general reference)
    if (this.checkUsage(from, to)) {
      return 'uses';
    }

    return null;
  }

  private checkUsage(symbol: Symbol, target: Symbol): boolean {
    // More sophisticated usage detection
    if (symbol.signature && target.name) {
      // Check for direct name reference
      const regex = new RegExp(`\\b${target.name}\\b`, 'g');
      return regex.test(symbol.signature);
    }
    return false;
  }

  async computePageRank(): Promise<void> {
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

    // PageRank algorithm with specifications from PLAN.md
    const damping = 0.85; // Standard damping factor
    const iterations = 30; // Usually enough
    const tolerance = 1e-6; // Convergence tolerance

    const n = symbols.length;
    const rank = new Map<string, number>();
    const baseRank = 1 / n;

    // Initialize ranks with base values and modifiers
    for (const symbol of symbols) {
      let multiplier = 1;

      // Exported symbols get 1.5x base score
      if (symbol.exported) {
        multiplier *= 1.5;
      }

      // Entry points (index.ts, main.py, etc.) get 2x score
      const filename = symbol.filepath.split('/').pop() || '';
      if (filename === 'index.ts' || filename === 'main.ts' ||
          filename === 'index.js' || filename === 'main.js' ||
          filename === 'index.py' || filename === 'main.py') {
        multiplier *= 2;
      }

      // Weight classes higher than functions, functions higher than variables
      if (symbol.kind === 'class' || symbol.kind === 'interface') {
        multiplier *= 1.3; // Classes get highest weight
      } else if (symbol.kind === 'function' || symbol.kind === 'method') {
        multiplier *= 1.15; // Functions get medium weight
      }
      // Variables get base weight (1.0)

      rank.set(symbol.id, baseRank * multiplier);
    }

    // Iterate PageRank
    for (let iter = 0; iter < iterations; iter++) {
      const newRank = new Map<string, number>();

      for (const symbol of symbols) {
        let sum = 0;

        // Sum incoming ranks from all linking symbols
        for (const [from, toSet] of graph.entries()) {
          if (toSet.has(symbol.id)) {
            const fromRank = rank.get(from) || 0;
            const outDegree = toSet.size;
            if (outDegree > 0) {
              sum += fromRank / outDegree;
            }
          }
        }

        // PageRank formula: PR = (1-d)/n + d * sum(PR_i/outDegree_i)
        const pageRank = (1 - damping) / n + damping * sum;
        newRank.set(symbol.id, pageRank);
      }

      // Check for convergence
      let converged = true;
      for (const [id, r] of rank.entries()) {
        const diff = Math.abs(r - (newRank.get(id) || 0));
        if (diff > tolerance) {
          converged = false;
          break;
        }
      }

      // Update ranks
      rank.clear();
      for (const [id, r] of newRank.entries()) {
        rank.set(id, r);
      }

      if (converged) break;
    }

    // Normalize PageRank scores to sum to 1
    const totalRank = Array.from(rank.values()).reduce((sum, r) => sum + r, 0);
    if (totalRank > 0) {
      for (const [id, r] of rank.entries()) {
        rank.set(id, r / totalRank);
      }
    }

    // Store PageRank scores
    await storage.setPageRanks(rank);
  }

  async getDependencies(
    target: string,
    depth: number = 1,
    types?: string[]
  ): Promise<{ direct: DependencyEdge[]; transitive: DependencyEdge[] }> {
    const visited = new Set<string>();
    const direct: DependencyEdge[] = [];
    const transitive: DependencyEdge[] = [];

    const dfs = async (current: string, currentDepth: number): Promise<void> => {
      if (currentDepth > depth || visited.has(current)) return;
      visited.add(current);

      const deps = await storage.getDependenciesFrom(current);
      const filteredDeps = types
        ? deps.filter(d => types.includes(d.type))
        : deps;

      if (currentDepth === 0) {
        direct.push(...filteredDeps);
      } else if (currentDepth > 0) {
        transitive.push(...filteredDeps);
      }

      for (const dep of filteredDeps) {
        await dfs(dep.to, currentDepth + 1);
      }
    };

    await dfs(target, 0);

    return { direct, transitive };
  }

  async getDependents(
    target: string,
    depth: number = 1
  ): Promise<{ direct: DependencyEdge[]; transitive: DependencyEdge[]; impactCount: number }> {
    const visited = new Set<string>();
    const direct: DependencyEdge[] = [];
    const transitive: DependencyEdge[] = [];

    const dfs = async (current: string, currentDepth: number): Promise<void> => {
      if (currentDepth > depth || visited.has(current)) return;
      visited.add(current);

      const deps = await storage.getDependenciesTo(current);

      if (currentDepth === 0) {
        direct.push(...deps);
      } else if (currentDepth > 0) {
        transitive.push(...deps);
      }

      for (const dep of deps) {
        await dfs(dep.from, currentDepth + 1);
      }
    };

    await dfs(target, 0);

    return {
      direct,
      transitive,
      impactCount: visited.size - 1, // Exclude the target itself
    };
  }

  async computeTransitiveDependencies(symbolId: string): Promise<Set<string>> {
    const visited = new Set<string>();
    const transitive = new Set<string>();

    const dfs = async (current: string): Promise<void> => {
      if (visited.has(current)) return;
      visited.add(current);

      const deps = await storage.getDependenciesFrom(current);
      for (const dep of deps) {
        transitive.add(dep.to);
        await dfs(dep.to);
      }
    };

    await dfs(symbolId);
    return transitive;
  }

  async computeTransitiveDependents(symbolId: string): Promise<Set<string>> {
    const visited = new Set<string>();
    const transitive = new Set<string>();

    const dfs = async (current: string): Promise<void> => {
      if (visited.has(current)) return;
      visited.add(current);

      const deps = await storage.getDependenciesTo(current);
      for (const dep of deps) {
        transitive.add(dep.from);
        await dfs(dep.from);
      }
    };

    await dfs(symbolId);
    return transitive;
  }

  async scoreSymbolImportance(symbolId: string): Promise<number> {
    // Get PageRank score
    const pageRanks = await storage.getPageRanks();
    const pageRankScore = pageRanks.get(symbolId) || 0;

    // Get symbol details
    const symbol = await storage.getSymbol(symbolId);
    if (!symbol) return 0;

    // Calculate additional factors
    let score = pageRankScore;

    // Exported symbols are more important
    if (symbol.exported) {
      score *= 1.5;
    }

    // Entry points are critical
    const filename = symbol.filepath.split('/').pop() || '';
    if (filename === 'index.ts' || filename === 'main.ts' ||
        filename === 'index.js' || filename === 'main.js' ||
        filename === 'index.py' || filename === 'main.py') {
      score *= 2;
    }

    // Symbol kind importance
    if (symbol.kind === 'class' || symbol.kind === 'interface') {
      score *= 1.3;
    } else if (symbol.kind === 'function' || symbol.kind === 'method') {
      score *= 1.15;
    }

    // Number of dependents (reverse dependencies)
    const dependents = await storage.getDependenciesTo(symbolId);
    score *= (1 + Math.log(dependents.length + 1) / 10);

    return score;
  }
}