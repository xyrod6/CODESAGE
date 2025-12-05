import { storage } from '../storage/index.js';
import { gitMetadata } from '../git/metadata.js';
import { Tool } from './index.js';
import { config } from '../config.js';

export const getSymbolHistory: Tool = {
  name: 'get_symbol_history',
  description: `Fetch git history metadata for a symbol or file - stability, churn, ownership.

WHEN TO USE: Use this to understand code stability before making changes. Shows churn count, stability score, last commit info, and top contributors. Helps identify risky code (high churn = frequently changing = more likely to have bugs or conflicts).`,
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Symbol ID or file path' },
      refresh: { type: 'boolean', description: 'Force a fresh git lookup even if cached' },
    },
    required: ['target'],
  },
  handler: async (args) => {
    const { target, refresh = false } = args;
    const isSymbolId = target.includes(':');

    try {
      if (isSymbolId) {
        const symbol = await storage.getSymbol(target);
        if (!symbol) {
          return {
            content: [
              {
                type: 'text',
                text: `Symbol not found: ${target}`,
              },
            ],
          };
        }

        const metadata = refresh
          ? await gitMetadata.getMetadata(symbol.filepath)
          : symbol.gitMetadata || await gitMetadata.getMetadata(symbol.filepath);

        if (metadata) {
          symbol.gitMetadata = metadata;
          await storage.addSymbols([symbol]);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                target,
                scope: 'symbol',
                filepath: symbol.filepath,
                git_enabled: config.git.enabled,
                refreshed: refresh,
                git: metadata || null,
                symbols: [
                  {
                    id: symbol.id,
                    name: symbol.name,
                    kind: symbol.kind,
                    filepath: symbol.filepath,
                    git: metadata || symbol.gitMetadata || null,
                  },
                ],
              }, null, 2),
            },
          ],
        };
      }

      const symbols = await storage.getSymbolsByFile(target);
      const baseMetadata = refresh
        ? await gitMetadata.getMetadata(target)
        : symbols[0]?.gitMetadata || await gitMetadata.getMetadata(target);

      if (baseMetadata && symbols.length > 0) {
        for (const symbol of symbols) {
          symbol.gitMetadata = baseMetadata;
        }
        await storage.addSymbols(symbols);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              target,
              scope: 'file',
              filepath: target,
              git_enabled: config.git.enabled,
              refreshed: refresh,
              git: baseMetadata || null,
              symbols: symbols.map(symbol => ({
                id: symbol.id,
                name: symbol.name,
                kind: symbol.kind,
                filepath: symbol.filepath,
                git: symbol.gitMetadata || baseMetadata || null,
              })),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving symbol history: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};
