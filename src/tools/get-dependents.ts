import { storage } from '../storage/index.js';
import { Tool } from './index.js';
import { ensureProjectContext } from './utils.js';

export const getDependents: Tool = {
  name: 'get_dependents',
  description: `Get what depends on a file or symbol - critical for impact analysis.

WHEN TO USE: Use this BEFORE modifying any file to understand what might break. Grep cannot reliably find all usages. This tool traces the actual dependency graph to find everything that imports, extends, or calls your target.`,
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'File path or symbol ID' },
      depth: { type: 'number', default: 1 },
      unstable_only: { type: 'boolean', description: 'When true, only include dependents with low stability' },
      stability_threshold: { type: 'number', description: 'Maximum stabilityScore considered unstable (default 0.5)' },
      include_git: { type: 'boolean', default: false, description: 'Include git metadata in the response' },
    },
    required: ['target'],
  },
  handler: async (args) => {
    const { target, depth = 1, unstable_only = false, stability_threshold = 0.5, include_git = false } = args;
    const unstableOnly = Boolean(unstable_only);
    const stabilityThreshold = typeof stability_threshold === 'number' ? stability_threshold : 0.5;
    const includeGit = Boolean(include_git);

    const formatGitMetadata = (symbol: any) => includeGit && symbol?.gitMetadata ? {
      lastCommitSha: symbol.gitMetadata.lastCommitSha,
      lastCommitAt: symbol.gitMetadata.lastCommitAt,
      churnCount: symbol.gitMetadata.churnCount,
      stabilityScore: symbol.gitMetadata.stabilityScore,
      freshnessDays: symbol.gitMetadata.freshnessDays,
      ownershipConfidence: symbol.gitMetadata.ownershipConfidence,
      topContributors: symbol.gitMetadata.topContributors,
    } : undefined;

    const isUnstable = (symbol: any) => {
      const stability = symbol?.gitMetadata?.stabilityScore;
      if (typeof stability === 'number') {
        return stability <= stabilityThreshold;
      }

      if (typeof symbol?.gitMetadata?.churnCount === 'number') {
        return symbol.gitMetadata.churnCount > 0;
      }

      return false;
    };

    try {
      await ensureProjectContext();
      // Check if target is a file path or symbol ID
      const isFilePath = !target.includes(':');
      let startId = target;

      if (isFilePath) {
        // Get all symbols from file
        const symbols = await storage.getSymbolsByFile(target);
        if (symbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No symbols found in file',
              },
            ],
          };
        }
        startId = symbols.map(s => s.id).join(',');
      }

      // Get dependents using reverse traversal
      const visited = new Set<string>();
      const direct: any[] = [];
      const transitive: any[] = [];

      const bfs = async (ids: string | string[], currentDepth: number) => {
        const idArray = typeof ids === 'string' ? ids.split(',') : ids;

        for (const id of idArray) {
          if (visited.has(id) || currentDepth > depth) continue;
          visited.add(id);

          const deps = await storage.getDependenciesTo(id);

          for (const dep of deps) {
            const sourceSymbol = await storage.getSymbol(dep.from);
            if (sourceSymbol) {
              const depInfo = {
                from: dep.from,
                to: dep.to,
                type: dep.type,
                location: dep.location,
                source: {
                  id: sourceSymbol.id,
                  name: sourceSymbol.name,
                  kind: sourceSymbol.kind,
                  filepath: sourceSymbol.filepath,
                  git: formatGitMetadata(sourceSymbol),
                },
              };

              if (!unstableOnly || isUnstable(sourceSymbol)) {
                if (currentDepth === 0) {
                  direct.push(depInfo);
                } else {
                  transitive.push(depInfo);
                }
              }

              await bfs(dep.from, currentDepth + 1);
            }
          }
        }
      };

      await bfs(startId, 0);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              target,
              direct,
              transitive,
              impact_count: visited.size - (typeof startId === 'string' ? startId.split(',').length : startId.length),
              summary: {
                direct_count: direct.length,
                transitive_count: transitive.length,
                total_impacted: visited.size,
                filtered_impacted: unstableOnly ? direct.length + transitive.length : undefined,
                filters: unstableOnly ? {
                  unstable_only: true,
                  stability_threshold: stabilityThreshold,
                } : { unstable_only: false },
              },
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting dependents: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};
