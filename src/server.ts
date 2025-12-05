import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { tools } from './tools/index.js';
import { storage } from './storage/index.js';

export const server = new Server(
  {
    name: 'agimake',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    return await tool.handler(args);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

// Register prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'analyze-code',
      description: 'Analyze code structure and relationships',
      arguments: [],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'analyze-code') {
    return {
      description: 'Analyze the current codebase structure',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Please analyze the codebase structure and provide insights about the project architecture.',
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

// Register resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'agimake://overview',
      name: 'Project Overview',
      description: 'High-level project structure and statistics',
      mimeType: 'application/json',
    },
    {
      uri: 'agimake://hot-symbols',
      name: 'Important Symbols',
      description: 'Top symbols by PageRank',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'agimake://overview') {
    try {
      const metadata = await storage.getProjectMetadata();
      if (!metadata) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                error: 'Project not indexed. Please run index_project first.',
              }, null, 2),
            },
          ],
        };
      }

      // Get directory structure
      const directoryStructure = await getDirectoryStructure(metadata.root, 3);

      // Get entry points
      const entryPoints = await findEntryPoints();

      // Get language stats
      const languageStats = await getLanguageStats();

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              stats: metadata.stats,
              languages: languageStats,
              directory_structure: directoryStructure,
              entry_points: entryPoints,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              error: `Error getting project overview: ${error instanceof Error ? error.message : String(error)}`,
            }, null, 2),
          },
        ],
      };
    }
  }

  if (uri === 'agimake://hot-symbols') {
    try {
      const { graph } = await import('./graph/index.js');
      const { relative } = await import('node:path');

      // Get project metadata
      const metadata = await storage.getProjectMetadata();
      if (!metadata) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                error: 'Project not indexed. Please run index_project first.',
              }, null, 2),
            },
          ],
        };
      }

      // Get top symbols
      const topSymbols = await graph.getTopSymbols(50);

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              symbols: topSymbols.map(({ symbol, score }) => ({
                id: symbol.id,
                name: symbol.name,
                kind: symbol.kind,
                filepath: relative(metadata.root, symbol.filepath),
                pageRank: score,
                exported: symbol.exported,
                signature: symbol.signature,
              })),
              total_symbols: topSymbols.length,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              error: `Error getting hot symbols: ${error instanceof Error ? error.message : String(error)}`,
            }, null, 2),
          },
        ],
      };
    }
  }

  throw new Error(`Unknown resource: ${uri}`);
});

async function getDirectoryStructure(rootPath: string, maxDepth: number): Promise<any[]> {
  const { readdir } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');

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
      if (entry.name.startsWith('.')) continue; // Skip hidden files

      const fullPath = join(path, entry.name);

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
  const { relative } = await import('node:path');
  const metadata = await storage.getProjectMetadata();

  if (!metadata) return [];

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
      entryPoints.push(relative(metadata.root, symbol.filepath));
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

// Initialize storage connection
async function initialize() {
  try {
    await storage.initialize();
    console.error('Storage initialized successfully');
  } catch (error) {
    console.error('Failed to initialize storage:', error);
    process.exit(1);
  }
}

// Initialize server
initialize().catch(error => {
  console.error('Failed to initialize server:', error);
  process.exit(1);
});