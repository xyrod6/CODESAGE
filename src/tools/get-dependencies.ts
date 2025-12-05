import { storage } from '../storage/index.js';
import { Tool } from './index.js';

export const getDependencies: Tool = {
  name: 'get_dependencies',
  description: `Get what a file or symbol depends on (imports, extends, calls, uses).

WHEN TO USE: Use this when you need to understand what a file/symbol relies on. Better than grepping for 'import' statements because it includes all dependency types and can traverse multiple levels deep.`,
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'File path or symbol ID' },
      depth: { type: 'number', default: 1, description: 'How deep to traverse' },
      types: { type: 'array', items: { type: 'string' }, description: 'Filter edge types' },
    },
    required: ['target'],
  },
  handler: async (args) => {
    const { target, depth = 1, types } = args;

    try {
      // Check if target is a file path or symbol ID
      const isFilePath = !target.includes(':');
      let startId = target;

      if (isFilePath) {
        // Get first symbol from file as starting point
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
        startId = symbols[0].id;
      }

      // Get dependencies using breadth-first search
      const visited = new Set<string>();
      const direct: any[] = [];
      const transitive: any[] = [];

      const bfs = async (id: string, currentDepth: number) => {
        if (visited.has(id) || currentDepth > depth) return;
        visited.add(id);

        const deps = await storage.getDependenciesFrom(id);
        const filteredDeps = types
          ? deps.filter(d => types.includes(d.type))
          : deps;

        for (const dep of filteredDeps) {
          const targetSymbol = await storage.getSymbol(dep.to);
          if (targetSymbol) {
            const depInfo = {
              from: id,
              to: dep.to,
              type: dep.type,
              location: dep.location,
              target: {
                id: targetSymbol.id,
                name: targetSymbol.name,
                kind: targetSymbol.kind,
                filepath: targetSymbol.filepath,
              },
            };

            if (currentDepth === 0) {
              direct.push(depInfo);
            } else {
              transitive.push(depInfo);
            }

            await bfs(dep.to, currentDepth + 1);
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
              summary: {
                direct_count: direct.length,
                transitive_count: transitive.length,
                total_unique: visited.size - 1,
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
            text: `Error getting dependencies: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};