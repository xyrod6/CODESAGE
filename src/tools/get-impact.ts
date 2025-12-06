import { storage } from '../storage/index.js';
import { graph } from '../graph/index.js';
import { Tool } from './index.js';
import { ensureProjectContext } from './utils.js';

export const getImpact: Tool = {
  name: 'get_impact',
  description: `Analyze impact of modifying files - shows what else might need changes.

WHEN TO USE: Use this BEFORE making changes to multiple files or critical code. Returns directly/transitively affected symbols, suggested modification order (topologically sorted), and high-risk dependents. Essential for safe refactoring.`,
  inputSchema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'Files to analyze' },
      unstable_only: { type: 'boolean', description: 'When true, return only symbols with low stability scores' },
      stability_threshold: { type: 'number', description: 'Maximum stabilityScore to consider unstable (default 0.5)' },
      include_git: { type: 'boolean', default: false, description: 'Include git metadata for symbols' },
    },
    required: ['files'],
  },
  handler: async (args) => {
    const { files, unstable_only = false, stability_threshold = 0.5, include_git = false } = args;
    const unstableOnly = Boolean(unstable_only);
    const stabilityThreshold = typeof stability_threshold === 'number' ? stability_threshold : 0.5;
    const includeGit = Boolean(include_git);

    try {
      await ensureProjectContext();
      // Get all symbols from the specified files
      const allSymbolIds: string[] = [];

      for (const file of files) {
        const symbols = await storage.getSymbolsByFile(file);
        allSymbolIds.push(...symbols.map(s => s.id));
      }

      if (allSymbolIds.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No symbols found in specified files',
            },
          ],
        };
      }

      // Analyze impact using enhanced graph traversal
      const impact = await graph.analyzeImpact(allSymbolIds);

      // Get PageRank scores for additional context
      const pageRanks = await storage.getPageRanks();

      const formatGitMetadata = (symbol: any) => includeGit && symbol.gitMetadata ? {
        lastCommitSha: symbol.gitMetadata.lastCommitSha,
        lastCommitAt: symbol.gitMetadata.lastCommitAt,
        churnCount: symbol.gitMetadata.churnCount,
        stabilityScore: symbol.gitMetadata.stabilityScore,
        freshnessDays: symbol.gitMetadata.freshnessDays,
        ownershipConfidence: symbol.gitMetadata.ownershipConfidence,
        topContributors: symbol.gitMetadata.topContributors,
      } : undefined;

      const isUnstable = (symbol: any) => {
        const stability = symbol.gitMetadata?.stabilityScore;
        if (typeof stability === 'number') {
          return stability <= stabilityThreshold;
        }

        if (typeof symbol.gitMetadata?.churnCount === 'number') {
          return symbol.gitMetadata.churnCount > 0;
        }

        return false;
      };

      const filterByStability = (symbols: any[]) => unstableOnly ? symbols.filter(isUnstable) : symbols;
      const serializeSymbol = (symbol: any) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        filepath: symbol.filepath,
        pageRank: pageRanks.get(symbol.id) || 0,
        git: formatGitMetadata(symbol),
      });

      // Enrich high-risk symbols with additional metadata
      const highRisk = await Promise.all(filterByStability(impact.highRisk).map(async symbol => {
        const dependents = await storage.getDependenciesTo(symbol.id);
        const dependencies = await storage.getDependenciesFrom(symbol.id);

        return {
          ...serializeSymbol(symbol),
          pageRank: pageRanks.get(symbol.id) || 0,
          dependentsCount: dependents.length,
          dependenciesCount: dependencies.length,
        };
      }));

      // Convert affected files Map to sorted array
      const sortedFiles = Array.from(impact.impactSummary.affectedFiles.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([file, count]) => ({
          file,
          symbolCount: count,
          riskLevel: count > 10 ? 'high' : count > 5 ? 'medium' : 'low',
        }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: {
                files_analyzed: files.length,
                symbols_analyzed: allSymbolIds.length,
                directly_affected: impact.directlyAffected.length,
                transitively_affected: impact.transitivelyAffected.length,
                total_affected: impact.impactSummary.totalAffected,
                total_affected_files: impact.impactSummary.affectedFiles.size,
                risk_distribution: impact.impactSummary.riskDistribution,
                filters: unstableOnly ? {
                  unstable_only: true,
                  stability_threshold: stabilityThreshold,
                } : { unstable_only: false },
                filtered_counts: unstableOnly ? {
                  directly_affected: filterByStability(impact.directlyAffected).length,
                  transitively_affected: filterByStability(impact.transitivelyAffected).length,
                  suggested_order: filterByStability(impact.suggestedOrder).length,
                  high_risk: highRisk.length,
                } : undefined,
              },
              directly_affected: filterByStability(impact.directlyAffected).map(serializeSymbol),
              transitively_affected: filterByStability(impact.transitivelyAffected).map(serializeSymbol),
              suggested_order: filterByStability(impact.suggestedOrder).map(serializeSymbol),
              high_risk_files: sortedFiles.slice(0, 10),
              high_risk_symbols: highRisk.slice(0, 20),
              critical_paths: impact.impactSummary.criticalPaths.slice(0, 5).map(path =>
                path.map(id => {
                  const symbol = allSymbolIds.find(s => s === id);
                  return symbol || id;
                })
              ),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing impact: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};
