#!/usr/bin/env node

import { server } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('AGImake MCP server started');
  } catch (error) {
    console.error('Failed to start AGImake server:', error);
    process.exit(1);
  }
}

main();