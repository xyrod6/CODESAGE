import { PageRankCalculator } from './pagerank.js';
import { GraphTraversal } from './traversal.js';
import { storage } from '../storage/index.js';
import { Symbol } from '../parsers/base.js';

export interface GraphNode {
  id: string;
  symbol: Symbol;
  weight: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  type: string;
}

export class Graph {
  private pageRank: PageRankCalculator;
  private traversal: GraphTraversal;

  constructor() {
    this.pageRank = new PageRankCalculator();
    this.traversal = new GraphTraversal();
  }

  async getTopSymbols(limit: number = 50): Promise<{ symbol: Symbol; score: number }[]> {
    const pageRanks = await storage.getPageRanks();
    const scores = Array.from(pageRanks.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const results: { symbol: Symbol; score: number }[] = [];

    for (const [id, score] of scores) {
      const symbol = await storage.getSymbol(id);
      if (symbol) {
        results.push({ symbol, score });
      }
    }

    return results;
  }

  async findPath(fromId: string, toId: string): Promise<Symbol[] | null> {
    return this.traversal.findPath(fromId, toId);
  }

  async getConnectedComponents(): Promise<Symbol[][]> {
    return this.traversal.getConnectedComponents();
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
    return this.traversal.analyzeImpact(symbolIds);
  }

  async findSimilar(targetSymbol: Symbol, limit: number = 5): Promise<{ symbol: Symbol; relevanceScore: number; reason: string }[]> {
    return this.traversal.findSimilar(targetSymbol, limit);
  }

  async findShortestPaths(fromId: string): Promise<Map<string, Symbol[]>> {
    return this.traversal.findShortestPaths(fromId);
  }

  async findCriticalPath(fromId: string, toId: string): Promise<Symbol[] | null> {
    return this.traversal.findCriticalPath(fromId, toId);
  }

  async findCycles(): Promise<Symbol[][]> {
    return this.traversal.findCycles();
  }

  async findBottlenecks(): Promise<{ symbol: Symbol; incoming: number; outgoing: number; score: number }[]> {
    return this.traversal.findBottlenecks();
  }

  async findDeadCode(): Promise<Symbol[]> {
    return this.traversal.findDeadCode();
  }
}

export const graph = new Graph();
export { PageRankCalculator } from './pagerank.js';
export { GraphTraversal } from './traversal.js';