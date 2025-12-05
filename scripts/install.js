#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json');
const AGIMAKE_CONFIG_TEMPLATE = {
  redis: {
    url: 'redis://localhost:6379',
    keyPrefix: 'agimake:'
  },
  indexer: {
    include: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.py',
      '**/*.go',
      '**/*.rs',
      '**/*.java',
      '**/*.c',
      '**/*.cpp',
      '**/*.h',
      '**/*.hpp'
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**'
    ],
    maxFileSize: 1048576
  },
  watcher: {
    enabled: true,
    debounceMs: 1000
  }
};

function getCliPath() {
  try {
    // Try to get the path from npm
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const codesagePath = join(npmRoot, 'codesage');
    return join(codesagePath, 'dist', 'index.js');
  } catch {
    // Fallback: assume codesage is in PATH
    return 'codesage';
  }
}

function updateClaudeConfig() {
  let claudeConfig = {};

  // Read existing config if it exists
  if (existsSync(CLAUDE_CONFIG_PATH)) {
    try {
      const configContent = readFileSync(CLAUDE_CONFIG_PATH, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Error reading existing Claude config:', error.message);
      process.exit(1);
    }
  }

  // Add or update agimake server config
  if (!claudeConfig.mcpServers) {
    claudeConfig.mcpServers = {};
  }

  const agimakePath = getCliPath();
  const configPath = join(homedir(), '.codesage.config.json');

  claudeConfig.mcpServers.codesage = {
    command: 'node',
    args: [agimakePath],
    env: {
      CODESAGE_CONFIG: configPath
    }
  };

  // Write updated config
  try {
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(claudeConfig, null, 2));
    console.log('✓ Updated ~/.claude.json');
  } catch (error) {
    console.error('Error writing Claude config:', error.message);
    process.exit(1);
  }

  // Create AGImake config if it doesn't exist
  if (!existsSync(configPath)) {
    try {
      writeFileSync(configPath, JSON.stringify(AGIMAKE_CONFIG_TEMPLATE, null, 2));
      console.log('✓ Created ~/.agimake.config.json');
    } catch (error) {
      console.error('Error creating AGImake config:', error.message);
    }
  }

  return configPath;
}

function checkRedis() {
  console.log('Checking Redis connection...');
  try {
    execSync('redis-cli ping', { stdio: 'ignore' });
    console.log('✓ Redis is running');
    return true;
  } catch {
    console.log('\n⚠️  Redis is not running');
    console.log('Please start Redis server:');
    console.log('  macOS: brew services start redis');
    console.log('  Ubuntu: sudo systemctl start redis-server');
    console.log('  Docker: docker run -d -p 6379:6379 redis');
    return false;
  }
}

function main() {
  console.log('CODESAGE Installation Helper');
  console.log('=============================\n');

  // Check Redis
  const redisRunning = checkRedis();

  // Update Claude config
  const configPath = updateClaudeConfig();

  console.log('\nInstallation complete!');
  console.log('\nNext steps:');
  console.log('1. Restart Claude Code if it\'s running');
  console.log('2. Make sure Redis is running');

  if (!redisRunning) {
    console.log('3. Start Redis (see instructions above)');
  }

  console.log('\nUsage examples:');
  console.log('  "Please index the current project using agimake"');
  console.log('  "Find all functions related to authentication"');
  console.log('  "What will break if I modify src/auth/AuthService.ts?"');

  console.log(`\nConfig file location: ${configPath}`);
  console.log('You can customize the settings in this file.');
}

main();