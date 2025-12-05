import { indexer } from '../indexer/index.js';
import { storage } from '../storage/index.js';
import { Tool } from './index.js';

export const indexProject: Tool = {
  name: 'index_project',
  description: `Index a project's codebase structure. Run this first.

WHEN TO USE: Run at the start of every new session or when you notice the index might be stale. This enables all other AGImake tools to work. Without indexing, you'll fall back to slow grep/glob searches.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project root path' },
      force: { type: 'boolean', description: 'Force full re-index', default: false },
    },
    required: ['path'],
  },
  handler: async (args) => {
    const { path, force = false } = args;

    try {
      // Check if already indexed
      if (!force) {
        const metadata = await storage.getProjectMetadata();
        if (metadata && metadata.root === path) {
          const stats = await indexer.indexProject(path, { incremental: true });
          return {
            content: [
              {
                type: 'text',
                text: `Incremental indexing complete:\n- Files indexed: ${stats.filesIndexed}\n- Symbols found: ${stats.symbolsFound}\n- Dependencies found: ${stats.dependenciesFound}\n- Time taken: ${stats.timeMs}ms`,
              },
            ],
          };
        }
      }

      // Full re-index
      const stats = await indexer.indexProject(path, { force });

      return {
        content: [
          {
            type: 'text',
            text: `Indexing complete:\n- Files indexed: ${stats.filesIndexed}\n- Symbols found: ${stats.symbolsFound}\n- Dependencies found: ${stats.dependenciesFound}\n- Time taken: ${stats.timeMs}ms`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error indexing project: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};