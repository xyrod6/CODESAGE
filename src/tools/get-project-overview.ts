import { storage } from '../storage/index.js';
import { graph } from '../graph/index.js';
import { Tool } from './index.js';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { config } from '../config.js';
import micromatch from 'micromatch';

export const getProjectOverview: Tool = {
  name: 'get_project_overview',
  description: `Get project structure and most important symbols ranked by PageRank.

WHEN TO USE: Use this as your FIRST step when exploring any codebase. Shows directory structure, top symbols by importance, entry points, and language stats. Much more informative than running 'ls' or Glob patterns. Use before diving into specific files.`,
  inputSchema: {
    type: 'object',
    properties: {
      top_n: { type: 'number', default: 25, description: 'Number of top symbols' },
      include_git: { type: 'boolean', default: false, description: 'Include git stability metadata in the response' },
    },
  },
  handler: async (args) => {
    const { top_n = 25, include_git = false } = args;
    const includeGit = Boolean(include_git);

    try {
      const metadata = await storage.getProjectMetadata();
      if (!metadata) {
        return {
          content: [
            {
              type: 'text',
              text: 'Project not indexed. Please run index_project first.',
            },
          ],
        };
      }

      // Get top symbols
      const topSymbols = await graph.getTopSymbols(top_n);

      // Get directory structure
      const directoryStructure = await getDirectoryStructure(metadata.root, 3);

      // Get entry points
      const entryPoints = await findEntryPoints();

      // Get language stats
      const languageStats = await getLanguageStats();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              stats: metadata.stats,
              languages: languageStats,
              directory_structure: directoryStructure,
              top_symbols: topSymbols.map(({ symbol, score }) => ({
                id: symbol.id,
                name: symbol.name,
                kind: symbol.kind,
                filepath: relative(metadata.root, symbol.filepath),
                pageRank: score,
                git: includeGit && symbol.gitMetadata ? {
                  lastCommitSha: symbol.gitMetadata.lastCommitSha,
                  lastCommitAt: symbol.gitMetadata.lastCommitAt,
                  churnCount: symbol.gitMetadata.churnCount,
                  stabilityScore: symbol.gitMetadata.stabilityScore,
                  freshnessDays: symbol.gitMetadata.freshnessDays,
                  ownershipConfidence: symbol.gitMetadata.ownershipConfidence,
                  topContributors: symbol.gitMetadata.topContributors,
                } : undefined,
              })),
              entry_points: entryPoints,
              git: includeGit ? {
                enabled: config.git.enabled,
                historyDepth: config.git.historyDepth,
                sampleWindowDays: config.git.sampleWindowDays,
              } : undefined,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting project overview: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};

async function getDirectoryStructure(rootPath: string, maxDepth: number): Promise<any[]> {
  const structure: any[] = [];

  async function buildStructure(path: string, depth: number): Promise<any> {
    if (depth > maxDepth) return null;

    const name = relative(rootPath, path) || '.';
    const entries = await readdir(path, { withFileTypes: true });

    const node: any = {
      name,
      type: 'directory',
      children: [],
    };

    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      const relativePath = relative(rootPath, fullPath);

      // Skip if matches exclude patterns
      if (micromatch.isMatch(relativePath, config.indexer.exclude)) {
        continue;
      }

      // Skip hidden files and directories
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const child = await buildStructure(fullPath, depth + 1);
        if (child) node.children.push(child);
      } else {
        const ext = entry.name.split('.').pop();
        if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp'].includes(ext || '')) {
          node.children.push({
            name: entry.name,
            type: 'file',
          });
        }
      }
    }

    return node;
  }

  return await buildStructure(rootPath, 0) || [];
}

async function findEntryPoints(): Promise<string[]> {
  const allSymbols = await storage.getAllSymbols();
  const entryPoints: string[] = [];

  for (const symbol of allSymbols) {
    const filename = symbol.filepath.split('/').pop()?.toLowerCase();

    if (
      filename?.includes('index') ||
      filename?.includes('main') ||
      filename?.includes('app') ||
      filename?.includes('server') ||
      filename?.includes('client')
    ) {
      entryPoints.push(symbol.filepath);
    }
  }

  return [...new Set(entryPoints)];
}

async function getLanguageStats(): Promise<Record<string, number>> {
  const allSymbols = await storage.getAllSymbols();
  const stats: Record<string, number> = {};

  for (const symbol of allSymbols) {
    stats[symbol.language] = (stats[symbol.language] || 0) + 1;
  }

  return stats;
}
