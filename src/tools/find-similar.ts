import { storage } from '../storage/index.js';
import { graph } from '../graph/index.js';
import { Tool } from './index.js';
import { ensureProjectContext } from './utils.js';

export const findSimilar: Tool = {
  name: 'find_similar',
  description: `Find similar existing code to use as reference when implementing new features.

WHEN TO USE: Use this when implementing something new to find existing patterns in the codebase. Describe what you're looking for in plain English (e.g., "error handling middleware", "database connection"). Returns ranked matches with explanations of why they're similar.`,
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What you\'re looking for' },
      kind: { type: 'string', description: 'Symbol kind to find' },
      limit: { type: 'number', default: 5 },
    },
    required: ['description'],
  },
  handler: async (args) => {
    const { description, kind, limit = 5 } = args;

    try {
      await ensureProjectContext();
      // Extract keywords from description
      const keywords = description.toLowerCase()
        .split(/\W+/)
        .filter((word: string) => word.length > 2)
        .filter((word: string) => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'would', 'could'].includes(word));

      // Get all symbols and filter by kind if specified
      const allSymbols = await storage.getAllSymbols();
      let candidateSymbols = kind
        ? allSymbols.filter(s => s.kind === kind)
        : allSymbols;

      // Score candidates based on keyword matching
      const scored = await Promise.all(
        candidateSymbols.map(async (symbol) => {
          let score = 0;
          const matches: string[] = [];

          // Name matching
          const name = symbol.name.toLowerCase();
          for (const keyword of keywords) {
            if (name.includes(keyword)) {
              score += 2;
              matches.push(`Name contains "${keyword}"`);
            }
          }

          // Docstring matching
          if (symbol.docstring) {
            const doc = symbol.docstring.toLowerCase();
            for (const keyword of keywords) {
              if (doc.includes(keyword)) {
                score += 1.5;
                matches.push(`Documentation mentions "${keyword}"`);
              }
            }
          }

          // File path matching
          const path = symbol.filepath.toLowerCase();
          for (const keyword of keywords) {
            if (path.includes(keyword)) {
              score += 0.5;
              matches.push(`Path contains "${keyword}"`);
            }
          }

          // Bonus for exported symbols
          if (symbol.exported) {
            score += 0.5;
            matches.push('Exported symbol');
          }

          // Bonus for high PageRank
          const pageRanks = await storage.getPageRanks();
          const rank = pageRanks.get(symbol.id) || 0;
          if (rank > 0.01) {
            score += rank * 10;
            matches.push(`Important symbol (PageRank: ${rank.toFixed(3)})`);
          }

          return {
            symbol,
            score,
            why: matches.join(', ') || 'Minimal relevance',
          };
        })
      );

      // Sort by score and limit
      scored.sort((a, b) => b.score - a.score);
      const topMatches = scored.slice(0, limit).filter(m => m.score > 0);

      // Enhance with more detailed analysis
      const matches = await Promise.all(
        topMatches.map(async (match) => {
          // Find similar patterns
          const similar = await graph.findSimilar(match.symbol, 3);

          return {
            symbol: {
              id: match.symbol.id,
              name: match.symbol.name,
              kind: match.symbol.kind,
              filepath: match.symbol.filepath,
              location: match.symbol.location,
              signature: match.symbol.signature,
              docstring: match.symbol.docstring,
              exported: match.symbol.exported,
            },
            relevance_score: match.score,
            why: match.why,
            similar_patterns: similar.slice(0, 2).map((s: any) => ({
              name: s.symbol.name,
              filepath: s.symbol.filepath,
              reason: s.reason,
            })),
          };
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: description,
              matches,
              total_found: matches.length,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error finding similar code: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};