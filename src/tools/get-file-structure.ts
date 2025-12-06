import { storage } from '../storage/index.js';
import { Tool } from './index.js';
import { ensureProjectContext } from './utils.js';

export const getFileStructure: Tool = {
  name: 'get_file_structure',
  description: `Get all symbols defined in a file with their structure and relationships.

WHEN TO USE: Use this INSTEAD of Read when you need to understand what's in a file without reading all the code. Returns classes, functions, methods in a structured format. Saves context tokens compared to reading the entire file.`,
  inputSchema: {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Path to file' },
      include_private: { type: 'boolean', default: true },
    },
    required: ['filepath'],
  },
  handler: async (args) => {
    const { filepath, include_private = true } = args;

    try {
      await ensureProjectContext();
      const symbols = await storage.getSymbolsByFile(filepath);

      // Filter private symbols if requested
      const filteredSymbols = include_private
        ? symbols
        : symbols.filter(s => s.exported);

      // Build nested structure
      const symbolMap = new Map();
      const rootSymbols: any[] = [];

      for (const symbol of filteredSymbols) {
        const symbolData = {
          id: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          location: symbol.location,
          signature: symbol.signature,
          docstring: symbol.docstring,
          exported: symbol.exported,
          children: [],
        };

        symbolMap.set(symbol.id, symbolData);

        if (symbol.parent) {
          const parent = symbolMap.get(symbol.parent);
          if (parent) {
            parent.children.push(symbolData);
          } else {
            // Parent not loaded yet, add to root temporarily
            rootSymbols.push(symbolData);
          }
        } else {
          rootSymbols.push(symbolData);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              filepath,
              language: symbols[0]?.language || 'unknown',
              symbols: rootSymbols,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting file structure: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};