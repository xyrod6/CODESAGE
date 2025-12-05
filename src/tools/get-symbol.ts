import { storage } from '../storage/index.js';
import { graph } from '../graph/index.js';
import { Tool } from './index.js';

export const getSymbol: Tool = {
  name: 'get_symbol',
  description: `Get detailed information about a symbol (class, function, variable, etc.).

WHEN TO USE: Use this INSTEAD of Grep when looking for a specific symbol by name. Provides fuzzy matching, PageRank importance scores, and related symbols. Much faster and more accurate than text search.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name (fuzzy matched)' },
      filepath: { type: 'string', description: 'Limit to specific file' },
      kind: { type: 'string', description: 'Filter by kind (class, function, etc.)' },
      limit: { type: 'number', default: 10, description: 'Maximum number of results' },
    },
    required: ['name'],
  },
  handler: async (args) => {
    const { name, filepath, kind, limit = 10 } = args;

    try {
      const allSymbols = await storage.getAllSymbols();
      const pageRanks = await storage.getPageRanks();
      const query = name.toLowerCase();

      // Score symbols based on fuzzy matching
      const scored = allSymbols.map(symbol => {
        let score = 0;
        const symbolName = symbol.name.toLowerCase();

        // Exact match gets highest score
        if (symbolName === query) {
          score = 100;
        }
        // Starts with query gets high score
        else if (symbolName.startsWith(query)) {
          score = 80;
        }
        // Contains query gets medium score
        else if (symbolName.includes(query)) {
          score = 50;
        }
        // Levenshtein distance-based fuzzy matching
        else {
          const distance = levenshteinDistance(query, symbolName);
          const maxLen = Math.max(query.length, symbolName.length);
          const similarity = 1 - (distance / maxLen);
          if (similarity > 0.6) {
            score = similarity * 40;
          }
        }

        // Apply filters
        if (filepath && symbol.filepath !== filepath) {
          score = 0;
        }

        if (kind && symbol.kind !== kind) {
          score = 0;
        }

        // Bonus for exported symbols
        if (symbol.exported) {
          score += 20;
        }

        // Bonus for PageRank
        const rank = pageRanks.get(symbol.id) || 0;
        score += rank * 1000;

        return { symbol, score };
      });

      // Filter and sort by score
      const matches = scored
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => item.symbol);

      // Get related symbols for each match
      const matchesWithRelations = await Promise.all(
        matches.map(async (symbol) => {
          const rank = pageRanks.get(symbol.id) || 0;

          // Get related symbols
          const related = await graph.findSimilar(symbol, 5);

          return {
            ...symbol,
            pageRank: rank,
            relatedSymbols: related.map((r: any) => ({
              id: r.symbol.id,
              name: r.symbol.name,
              kind: r.symbol.kind,
              filepath: r.symbol.filepath,
              relevanceScore: r.relevanceScore,
              reason: r.reason,
            })),
          };
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: name,
              matches: matchesWithRelations,
              total_found: matchesWithRelations.length,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting symbol: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};

// Simple Levenshtein distance implementation for fuzzy matching
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}
