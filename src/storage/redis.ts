import Redis from 'ioredis';
import { config } from '../config.js';
import { Symbol, DependencyEdge, DependencyType } from '../parsers/base.js';
import { IStorage, FileTracking, ProjectMetadata } from './index.js';
import { RedisAutoStart } from './redis-auto-start.js';

export class Storage implements IStorage {
  private redis: Redis;
  private projectName: string;
  private redisAutoStart: RedisAutoStart;
  private projectContextLock: Promise<void> = Promise.resolve();

  // Lua scripts for complex operations
  private static readonly UPDATE_DEPENDENCY_SCRIPT = `
    local fromKey = KEYS[1]
    local toKey = KEYS[2]
    local fromId = ARGV[1]
    local toId = ARGV[2]
    local depType = ARGV[3]
    local location = ARGV[4]

    -- Store dependency with metadata
    redis.call('HSET', fromKey .. ':' .. toId, 'type', depType, 'location', location)
    redis.call('SADD', fromKey, toId)
    redis.call('SADD', toKey, fromId)

    return 1
  `;

  private static readonly CLEANUP_SYMBOL_SCRIPT = `
    local symbolKey = KEYS[1]
    local fileIdxKey = KEYS[2]
    local nameIdxKey = KEYS[3]
    local kindIdxKey = KEYS[4]
    local depsFromKey = KEYS[5]
    local depsToKey = KEYS[6]
    local symbolId = ARGV[1]
    local filepath = ARGV[2]
    local name = ARGV[3]
    local kind = ARGV[4]

    -- Extract base key pattern for deps
    local baseKey = depsFromKey
    local colonPos = string.find(baseKey, ':deps:from:')
    if colonPos then
      baseKey = string.sub(baseKey, 1, colonPos + 10) -- Keep '...:deps:from:'
    end

    -- Remove symbol data
    redis.call('DEL', symbolKey)

    -- Remove from indexes
    redis.call('SREM', fileIdxKey, symbolId)
    redis.call('SREM', nameIdxKey, symbolId)
    redis.call('SREM', kindIdxKey, symbolId)

    -- Get and clean dependencies
    local toIds = redis.call('SMEMBERS', depsFromKey)
    for _, toId in ipairs(toIds) do
      redis.call('DEL', baseKey .. ':to:' .. toId)
      redis.call('SREM', string.gsub(baseKey, ':from:', ':to:') .. toId, symbolId)
    end

    local fromIds = redis.call('SMEMBERS', depsToKey)
    for _, fromId in ipairs(fromIds) do
      redis.call('DEL', string.gsub(depsToKey, ':to:', ':from:') .. fromId .. ':to:' .. symbolId)
      redis.call('SREM', string.gsub(depsToKey, ':to:', ':from:') .. fromId, symbolId)
    end

    -- Remove dependency sets
    redis.call('DEL', depsFromKey)
    redis.call('DEL', depsToKey)

    -- Remove from PageRank
    redis.call('ZREM', string.gsub(depsFromKey, ':deps:from:.*', ':pagerank'), symbolId)

    return 1
  `;

  constructor() {
    // Initialize Redis auto-start utility
    this.redisAutoStart = new RedisAutoStart({
      redisUrl: config.redis.url,
      log: (message: string) => {
        console.error(`[Redis Auto-Start] ${message}`);
      }
    });

    this.redis = new Redis(config.redis.url, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 5,
      lazyConnect: true,
    });

    // Use current working directory as project name for now
    this.projectName = this.generateProjectName(process.cwd());

    // Define Lua scripts
    this.redis.defineCommand('updateDependency', {
      numberOfKeys: 2,
      lua: Storage.UPDATE_DEPENDENCY_SCRIPT,
    });

    this.redis.defineCommand('cleanupSymbol', {
      numberOfKeys: 6,
      lua: Storage.CLEANUP_SYMBOL_SCRIPT,
    });
  }

  private generateProjectName(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '_');
  }

  private async ensureContextStable(): Promise<void> {
    // Wait for any pending context switches to complete
    await this.projectContextLock;
  }

  private k(key: string): string {
    return `agimake:${this.projectName}:${key}`;
  }

  async initialize(): Promise<void> {
    try {
      // First, try to ensure Redis is running
      const redisStatus = await this.redisAutoStart.ensureRedisRunning();

      if (!redisStatus.success) {
        // If auto-start failed, still try to connect in case Redis was started manually
        console.error(`Redis auto-start failed: ${redisStatus.message}`);
        console.error('Attempting to connect anyway...');
      } else if (redisStatus.wasStarted) {
        console.error(redisStatus.message);
      }

      // Try to connect to Redis
      await this.redis.connect();

      // Verify connection
      const result = await this.redis.ping();
      if (result !== 'PONG') {
        throw new Error('Redis ping failed');
      }

      console.error('Connected to Redis successfully');
    } catch (error) {
      console.error('Failed to connect to Redis:', error);

      // Provide helpful error message
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED')) {
          console.error('\nRedis connection refused. Please ensure Redis is running:');
          console.error('  1. Install Redis if not already installed');
          console.error('  2. Start Redis server manually: redis-server');
          console.error('  3. Or let AGImake start it automatically (if possible)');
        } else if (error.message.includes('ENOENT')) {
          console.error('\nRedis executable not found. Please install Redis:');
          console.error('  macOS: brew install redis');
          console.error('  Ubuntu/Debian: sudo apt-get install redis-server');
          console.error('  Windows: Download from https://redis.io/download');
        }
      }

      throw error;
    }
  }

  async setProjectContext(projectPath: string): Promise<void> {
    // Use a simple lock to ensure context switches are atomic
    await this.projectContextLock;

    let resolveLock: () => void;
    this.projectContextLock = new Promise((resolve) => {
      resolveLock = resolve;
    });

    try {
      this.projectName = this.generateProjectName(projectPath);
    } finally {
      resolveLock!();
    }
  }

  async acquireLock(lockName: string, ttlMs: number = 30000): Promise<boolean> {
    const lockKey = this.k(`lock:${lockName}`);
    const lockValue = `${Date.now()}`;

    // Try to acquire the lock using SET NX (only set if not exists) with expiration
    const result = await this.redis.set(lockKey, lockValue, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(lockName: string): Promise<void> {
    const lockKey = this.k(`lock:${lockName}`);
    await this.redis.del(lockKey);
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error) {
      // Ignore errors during quit
      console.error('Error closing Redis connection:', error);
    } finally {
      // Cleanup auto-start resources
      this.redisAutoStart.cleanup();
    }
  }

  async addSymbols(symbols: Symbol[]): Promise<void> {
    if (symbols.length === 0) return;

    // Process in batches to avoid pipeline getting too large
    const batchSize = 1000;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await this.addSymbolsBatch(batch);
    }
  }

  private async addSymbolsBatch(symbols: Symbol[]): Promise<void> {
    const pipeline = this.redis.multi();

    for (const symbol of symbols) {
      // Serialize location
      const locationData = JSON.stringify(symbol.location);

      // Store symbol data as hash
      pipeline.hset(this.k(`symbol:${symbol.id}`), {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        filepath: symbol.filepath,
        location: locationData,
        signature: symbol.signature || '',
        docstring: symbol.docstring || '',
        parent: symbol.parent || '',
        children: JSON.stringify(symbol.children),
        exported: symbol.exported ? '1' : '0',
        language: symbol.language,
        gitMetadata: symbol.gitMetadata ? JSON.stringify(symbol.gitMetadata) : '',
      });

      // Add to indexes
      pipeline.sadd(this.k(`idx:file:${symbol.filepath}`), symbol.id);
      pipeline.sadd(this.k(`idx:name:${symbol.name}`), symbol.id);
      pipeline.sadd(this.k(`idx:kind:${symbol.kind}`), symbol.id);
    }

    // Execute all commands in a transaction
    const results = await pipeline.exec();

    // Check for errors
    if (results) {
      for (const [err, result] of results) {
        if (err) {
          console.error('Error in batch operation:', err);
          throw err;
        }
      }
    }
  }

  async getSymbol(id: string): Promise<Symbol | null> {
    const data = await this.redis.hgetall(this.k(`symbol:${id}`)) as Record<string, string>;

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    try {
      // Parse location (new format) or fall back to old format
      let location;
      if (data.location) {
        location = JSON.parse(data.location);
      } else {
        // Backward compatibility
        location = {
          start: { line: parseInt(data.startLine || '0'), column: parseInt(data.startCol || '0') },
          end: { line: parseInt(data.endLine || '0'), column: parseInt(data.endCol || '0') },
        };
      }

      return {
        id: data.id,
        name: data.name,
        kind: data.kind as any,
        filepath: data.filepath,
        location,
        signature: data.signature || undefined,
        docstring: data.docstring || undefined,
        parent: data.parent || undefined,
        children: JSON.parse(data.children || '[]'),
        exported: data.exported === '1',
        language: data.language,
        gitMetadata: data.gitMetadata ? JSON.parse(data.gitMetadata) : undefined,
        pageRank: data.pageRank ? parseFloat(data.pageRank) : undefined,
      };
    } catch (error) {
      console.error(`Error parsing symbol ${id}:`, error);
      return null;
    }
  }

  async getSymbolsByFile(filepath: string): Promise<Symbol[]> {
    const symbolIds = await this.redis.smembers(this.k(`idx:file:${filepath}`));

    if (symbolIds.length === 0) {
      return [];
    }

    // Use pipeline for parallel fetch
    const pipeline = this.redis.pipeline();
    for (const id of symbolIds) {
      pipeline.hgetall(this.k(`symbol:${id}`));
    }

    const results = await pipeline.exec();
    const symbols: Symbol[] = [];

    if (results) {
      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (err) {
          console.error(`Error fetching symbol ${symbolIds[i]}:`, err);
          continue;
        }

        const dataRecord = data as Record<string, string>;
        if (dataRecord && Object.keys(dataRecord).length > 0) {
          try {
            // Parse location (new format) or fall back to old format
            let location;
            if (dataRecord.location) {
              location = JSON.parse(dataRecord.location);
            } else {
              // Backward compatibility
              location = {
                start: { line: parseInt(dataRecord.startLine || '0'), column: parseInt(dataRecord.startCol || '0') },
                end: { line: parseInt(dataRecord.endLine || '0'), column: parseInt(dataRecord.endCol || '0') },
              };
            }

            const symbol: Symbol = {
              id: dataRecord.id,
              name: dataRecord.name,
              kind: dataRecord.kind as any,
              filepath: dataRecord.filepath,
              location,
              signature: dataRecord.signature || undefined,
              docstring: dataRecord.docstring || undefined,
              parent: dataRecord.parent || undefined,
              children: JSON.parse(dataRecord.children || '[]'),
              exported: dataRecord.exported === '1',
              language: dataRecord.language,
              gitMetadata: dataRecord.gitMetadata ? JSON.parse(dataRecord.gitMetadata) : undefined,
              pageRank: dataRecord.pageRank ? parseFloat(dataRecord.pageRank) : undefined,
            };

            symbols.push(symbol);
          } catch (error) {
            console.error(`Error parsing symbol ${symbolIds[i]}:`, error);
          }
        }
      }
    }

    return symbols;
  }

  async removeSymbol(id: string): Promise<void> {
    const symbol = await this.getSymbol(id);
    if (!symbol) return;

    try {
      // Use Lua script for efficient atomic cleanup
      await (this.redis as any).cleanupSymbol(
        this.k(`symbol:${id}`),
        this.k(`idx:file:${symbol.filepath}`),
        this.k(`idx:name:${symbol.name}`),
        this.k(`idx:kind:${symbol.kind}`),
        this.k(`deps:from:${id}`),
        this.k(`deps:to:${id}`),
        id,
        symbol.filepath,
        symbol.name,
        symbol.kind
      );
    } catch (error) {
      console.error(`Error removing symbol ${id}:`, error);
      throw error;
    }
  }

  async addDependencies(dependencies: DependencyEdge[]): Promise<void> {
    if (dependencies.length === 0) return;

    // Process in batches to avoid pipeline getting too large
    const batchSize = 1000;
    for (let i = 0; i < dependencies.length; i += batchSize) {
      const batch = dependencies.slice(i, i + batchSize);
      await this.addDependenciesBatch(batch);
    }
  }

  private async addDependenciesBatch(dependencies: DependencyEdge[]): Promise<void> {
    const pipeline = this.redis.multi();

    for (const dep of dependencies) {
      // Store dependency metadata
      const depKey = this.k(`deps:from:${dep.from}:to:${dep.to}`);
      pipeline.hset(depKey, {
        type: dep.type,
        location: dep.location ? JSON.stringify(dep.location) : '',
      });

      // Add to dependency indexes
      pipeline.sadd(this.k(`deps:from:${dep.from}`), dep.to);
      pipeline.sadd(this.k(`deps:to:${dep.to}`), dep.from);
    }

    const results = await pipeline.exec();

    // Check for errors
    if (results) {
      for (const [err, result] of results) {
        if (err) {
          console.error('Error in dependency batch operation:', err);
          throw err;
        }
      }
    }
  }

  async getDependenciesFrom(id: string): Promise<DependencyEdge[]> {
    const toIds = await this.redis.smembers(this.k(`deps:from:${id}`));

    if (toIds.length === 0) {
      return [];
    }

    // Use pipeline for parallel fetch of dependency metadata
    const pipeline = this.redis.pipeline();
    for (const to of toIds) {
      pipeline.hgetall(this.k(`deps:from:${id}:to:${to}`));
    }

    const results = await pipeline.exec();
    const deps: DependencyEdge[] = [];

    if (results) {
      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (err) {
          console.error(`Error fetching dependency from ${id} to ${toIds[i]}:`, err);
          continue;
        }

        const dataRecord = data as Record<string, string>;
        const dep: DependencyEdge = {
          from: id,
          to: toIds[i],
          type: (dataRecord?.type as DependencyType) || 'uses',
        };

        if (dataRecord?.location) {
          try {
            dep.location = JSON.parse(dataRecord.location);
          } catch (e) {
            console.error(`Error parsing dependency location:`, e);
          }
        }

        deps.push(dep);
      }
    }

    return deps;
  }

  async getDependenciesTo(id: string): Promise<DependencyEdge[]> {
    const fromIds = await this.redis.smembers(this.k(`deps:to:${id}`));

    if (fromIds.length === 0) {
      return [];
    }

    // Use pipeline for parallel fetch of dependency metadata
    const pipeline = this.redis.pipeline();
    for (const from of fromIds) {
      pipeline.hgetall(this.k(`deps:from:${from}:to:${id}`));
    }

    const results = await pipeline.exec();
    const deps: DependencyEdge[] = [];

    if (results) {
      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i];
        if (err) {
          console.error(`Error fetching dependency from ${fromIds[i]} to ${id}:`, err);
          continue;
        }

        const dataRecord = data as Record<string, string>;
        const dep: DependencyEdge = {
          from: fromIds[i],
          to: id,
          type: (dataRecord?.type as DependencyType) || 'uses',
        };

        if (dataRecord?.location) {
          try {
            dep.location = JSON.parse(dataRecord.location);
          } catch (e) {
            console.error(`Error parsing dependency location:`, e);
          }
        }

        deps.push(dep);
      }
    }

    return deps;
  }

  async getAllSymbols(): Promise<Symbol[]> {
    const symbols: Symbol[] = [];
    const pattern = this.k('symbol:*');
    let cursor = '0';

    do {
      try {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = result[0];
        const keys = result[1];

        if (keys.length > 0) {
          // Extract IDs from keys - remove the prefix to get the full ID
          const prefix = this.k('symbol:');
          const ids = keys.map(key => key.startsWith(prefix) ? key.slice(prefix.length) : key).filter(Boolean);

          // Use pipeline to fetch symbols in parallel
          const pipeline = this.redis.pipeline();
          for (const id of ids) {
            pipeline.hgetall(this.k(`symbol:${id}`));
          }

          const results = await pipeline.exec();

          if (results) {
            for (let i = 0; i < results.length; i++) {
              const [err, data] = results[i];
              if (err) {
                console.error(`Error fetching symbol ${ids[i]}:`, err);
                continue;
              }

              const dataRecord = data as Record<string, string>;
              if (dataRecord && Object.keys(dataRecord).length > 0) {
                try {
                  // Parse location (new format) or fall back to old format
                  let location;
                  if (dataRecord.location) {
                    location = JSON.parse(dataRecord.location);
                  } else {
                    // Backward compatibility
                    location = {
                      start: { line: parseInt(dataRecord.startLine || '0'), column: parseInt(dataRecord.startCol || '0') },
                      end: { line: parseInt(dataRecord.endLine || '0'), column: parseInt(dataRecord.endCol || '0') },
                    };
                  }

                  const symbol: Symbol = {
                    id: dataRecord.id,
                    name: dataRecord.name,
                    kind: dataRecord.kind as any,
                    filepath: dataRecord.filepath,
                    location,
                    signature: dataRecord.signature || undefined,
                    docstring: dataRecord.docstring || undefined,
                    parent: dataRecord.parent || undefined,
                    children: JSON.parse(dataRecord.children || '[]'),
                    exported: dataRecord.exported === '1',
                    language: dataRecord.language,
                    gitMetadata: dataRecord.gitMetadata ? JSON.parse(dataRecord.gitMetadata) : undefined,
                    pageRank: dataRecord.pageRank ? parseFloat(dataRecord.pageRank) : undefined,
                  };

                  symbols.push(symbol);
                } catch (error) {
                  console.error(`Error parsing symbol ${ids[i]}:`, error);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Error scanning symbols:', error);
        break;
      }
    } while (cursor !== '0');

    return symbols;
  }

  async getAllDependencies(): Promise<DependencyEdge[]> {
    const deps: DependencyEdge[] = [];
    const pattern = this.k('deps:from:*');
    let cursor = '0';

    do {
      try {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = result[0];
        const keys = result[1];

        for (const key of keys) {
          // Extract from ID from key (pattern: agimake:project:deps:from:{from})
          const prefix = this.k('deps:from:');
          const fromId = key.startsWith(prefix) ? key.slice(prefix.length) : key.split(':').pop();
          if (!fromId || key.includes(':to:')) continue; // Skip metadata keys

          const toIds = await this.redis.smembers(key);
          if (toIds.length === 0) continue;

          // Use pipeline to fetch dependency metadata
          const pipeline = this.redis.pipeline();
          for (const toId of toIds) {
            pipeline.hgetall(this.k(`deps:from:${fromId}:to:${toId}`));
          }

          const results = await pipeline.exec();

          if (results) {
            for (let i = 0; i < results.length; i++) {
              const [err, data] = results[i];
              if (err) {
                console.error(`Error fetching dependency from ${fromId} to ${toIds[i]}:`, err);
                continue;
              }

              const dataRecord = data as Record<string, string>;
              const dep: DependencyEdge = {
                from: fromId,
                to: toIds[i],
                type: (dataRecord?.type as DependencyType) || 'uses',
              };

              if (dataRecord?.location) {
                try {
                  dep.location = JSON.parse(dataRecord.location);
                } catch (e) {
                  console.error(`Error parsing dependency location:`, e);
                }
              }

              deps.push(dep);
            }
          }
        }
      } catch (error) {
        console.error('Error scanning dependencies:', error);
        break;
      }
    } while (cursor !== '0');

    return deps;
  }

  async setPageRanks(ranks: Map<string, number>): Promise<void> {
    if (ranks.size === 0) return;

    // Clear existing PageRank
    await this.redis.del(this.k('pagerank'));

    // Add new scores in batches
    const batchSize = 1000;
    const entries = Array.from(ranks.entries());

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const pipeline = this.redis.multi();

      for (const [id, score] of batch) {
        // Store in sorted set for ranking queries
        pipeline.zadd(this.k('pagerank'), score, id);
        // Also store in the symbol hash for easy retrieval
        pipeline.hset(this.k(`symbol:${id}`), 'pageRank', score.toString());
      }

      const results = await pipeline.exec();

      // Check for errors
      if (results) {
        for (const [err, result] of results) {
          if (err) {
            console.error('Error in PageRank batch operation:', err);
            throw err;
          }
        }
      }
    }
  }

  async getPageRanks(): Promise<Map<string, number>> {
    const results = await this.redis.zrevrange(this.k('pagerank'), 0, -1, 'WITHSCORES');
    const ranks = new Map<string, number>();

    // ioredis returns an array of [member, score, member, score, ...]
    for (let i = 0; i < results.length; i += 2) {
      const member = results[i];
      const score = results[i + 1];
      if (typeof member === 'string' && typeof score === 'string') {
        ranks.set(member, parseFloat(score));
      }
    }

    return ranks;
  }

  async setFileTracking(filepath: string, tracking: FileTracking): Promise<void> {
    await this.redis.hset(this.k(`file:${filepath}`), {
      mtime: tracking.mtime.toString(),
      hash: tracking.hash,
    });
  }

  async getFileTracking(filepath: string): Promise<FileTracking | null> {
    const data = await this.redis.hgetall(this.k(`file:${filepath}`));

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      mtime: parseInt(data.mtime),
      hash: data.hash,
    };
  }

  async removeFileTracking(filepath: string): Promise<void> {
    await this.redis.del(this.k(`file:${filepath}`));
  }

  async updateProjectMetadata(metadata: ProjectMetadata): Promise<void> {
    const pipeline = this.redis.multi();

    // Update individual metadata fields according to PLAN.md schema
    pipeline.set(this.k('root'), metadata.root);
    pipeline.set(this.k('indexed_at'), metadata.indexedAt);
    pipeline.set(this.k('stats'), JSON.stringify(metadata.stats));

    const results = await pipeline.exec();

    // Check for errors
    if (results) {
      for (const [err, result] of results) {
        if (err) {
          console.error('Error updating project metadata:', err);
          throw err;
        }
      }
    }
  }

  async getProjectMetadata(): Promise<ProjectMetadata | null> {
    // Fetch individual metadata fields according to PLAN.md schema
    const pipeline = this.redis.pipeline();
    pipeline.get(this.k('root'));
    pipeline.get(this.k('indexed_at'));
    pipeline.get(this.k('stats'));

    const results = await pipeline.exec();

    if (!results) {
      return null;
    }

    const [, root] = results[0];
    const [, indexedAt] = results[1];
    const [, statsStr] = results[2];

    if (!root || !indexedAt || !statsStr || typeof root !== 'string' || typeof indexedAt !== 'string' || typeof statsStr !== 'string') {
      return null;
    }

    try {
      const stats = JSON.parse(statsStr);

      return {
        root,
        indexedAt,
        stats: {
          files: parseInt(stats.files) || 0,
          symbols: parseInt(stats.symbols) || 0,
          edges: parseInt(stats.edges) || 0,
        },
      };
    } catch (error) {
      console.error('Error parsing project metadata:', error);
      return null;
    }
  }
}

// Already exported as Storage
