import { storage } from '../storage/index.js';
import { Tool } from './index.js';

export const searchSymbols: Tool = {
  name: 'search_symbols',
  description: `Search symbols by name pattern with wildcard support.

WHEN TO USE: Use this INSTEAD of Grep/Glob when searching for classes, functions, or variables by pattern (e.g., "*Handler", "get*"). Returns ranked results with PageRank scores. Prefer this over text-based search for any code symbol lookup.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (supports * wildcards)' },
      kind: { type: 'string', description: 'Filter by symbol kind' },
      exported_only: { type: 'boolean', default: false },
      limit: { type: 'number', default: 20 },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const { query, kind, exported_only = false, limit = 20 } = args;

    try {
      // Convert wildcard pattern to regex
      const pattern = query.replace(/\*/g, '.*');
      const regex = new RegExp(pattern, 'i');

      // Get all symbols and PageRank scores
      const allSymbols = await storage.getAllSymbols();
      const pageRanks = await storage.getPageRanks();

      // Calculate relevance score for each symbol
      const scored = await Promise.all(allSymbols.map(async (symbol) => {
        let score = 0;

        // Name match score
        if (regex.test(symbol.name)) {
          // Exact match gets highest score
          if (symbol.name.toLowerCase() === query.toLowerCase()) {
            score += 100;
          }
          // Starts with query gets high score
          else if (symbol.name.toLowerCase().startsWith(query.toLowerCase())) {
            score += 80;
          }
          // Contains query gets medium score
          else {
            score += 50;
          }
        }

        // Apply filters
        if (kind && symbol.kind !== kind) {
          score = 0;
        }

        if (exported_only && !symbol.exported) {
          score = 0;
        }

        // Bonus for exported symbols
        if (symbol.exported) {
          score += 20;
        }

        // Bonus for PageRank
        const rank = pageRanks.get(symbol.id) || 0;
        score += rank * 1000;

        // Bonus for common symbol types
        if (symbol.kind === 'class' || symbol.kind === 'interface') {
          score += 10;
        }

        return { symbol, score };
      }));

      // Filter and sort by score
      let results = scored
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => ({
          ...item.symbol,
          pageRank: pageRanks.get(item.symbol.id) || 0,
          relevanceScore: Math.round(item.score),
        }));

      // Group by kind for better organization
      const grouped = results.reduce((acc, symbol) => {
        if (!acc[symbol.kind]) {
          acc[symbol.kind] = [];
        }
        acc[symbol.kind].push(symbol);
        return acc;
      }, {} as Record<string, typeof results>);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query,
              results,
              grouped,
              total_matches: results.length,
              filters: {
                kind: kind || 'all',
                exported_only,
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
            text: `Error searching symbols: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};
