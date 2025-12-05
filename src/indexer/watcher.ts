import { watch, FSWatcher } from 'chokidar';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storage } from '../storage/index.js';
import { SymbolExtractor } from './symbol-extractor.js';
import { config } from '../config.js';
import { EventEmitter } from 'node:events';
import { gitMetadata } from '../git/metadata.js';

export interface WatcherEvents {
  'fileChanged': { filepath: string; type: 'change' | 'add' | 'delete' };
  'batchChange': { files: string[]; type: 'change' | 'add' | 'delete' };
}

export class Watcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private symbolExtractor: SymbolExtractor;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private batchTimer: NodeJS.Timeout | null = null;
  private batchedChanges: Map<string, 'change' | 'add' | 'delete'> = new Map();

  constructor() {
    super();
    this.symbolExtractor = new SymbolExtractor();
  }

  isActive(): boolean {
    return this.watcher !== null;
  }

  async start(projectPath: string): Promise<void> {
    if (!config.watcher.enabled) return;

    console.error('Starting file watcher...');

    this.watcher = watch(projectPath, {
      ignored: config.indexer.exclude,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher
      .on('change', (filepath) => {
        this.handleFileChange(filepath, 'change');
      })
      .on('add', (filepath) => {
        this.handleFileChange(filepath, 'add');
      })
      .on('unlink', (filepath) => {
        this.handleFileChange(filepath, 'delete');
      });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchedChanges.clear();

    // Remove all listeners
    this.removeAllListeners();
  }

  private async handleFileChange(filepath: string, type: 'change' | 'add' | 'delete'): Promise<void> {
    // Emit event immediately for external listeners
    this.emit('fileChanged', { filepath, type });

    // Add to batch for batch processing
    this.batchedChanges.set(filepath, type);
    this.scheduleBatchProcessing();

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filepath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(async () => {
      try {
        if (type === 'delete') {
          await this.handleFileDelete(filepath);
        } else {
          await this.handleFileUpdate(filepath);
        }
      } catch (error) {
        console.error(`Error handling file change for ${filepath}:`, error);
      } finally {
        this.debounceTimers.delete(filepath);
        this.batchedChanges.delete(filepath);
      }
    }, config.watcher.debounceMs);

    this.debounceTimers.set(filepath, timer);
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      const changes = Array.from(this.batchedChanges.entries());
      if (changes.length > 0) {
        // Group changes by type
        const grouped = changes.reduce((acc, [path, type]) => {
          if (!acc[type]) acc[type] = [];
          acc[type].push(path);
          return acc;
        }, {} as Record<string, string[]>);

        // Emit batch events
        for (const [type, files] of Object.entries(grouped)) {
          this.emit('batchChange', { files, type: type as 'change' | 'add' | 'delete' });
        }

        this.batchedChanges.clear();
      }
      this.batchTimer = null;
    }, config.watcher.debounceMs * 2); // Wait a bit longer for batch processing
  }

  private async handleFileDelete(filepath: string): Promise<void> {
    // Remove all symbols for this file
    const symbols = await storage.getSymbolsByFile(filepath);
    for (const symbol of symbols) {
      await storage.removeSymbol(symbol.id);
    }

    // Remove file tracking info
    await storage.removeFileTracking(filepath);

    console.error(`Deleted file and its symbols: ${filepath}`);
  }

  private async handleFileUpdate(filepath: string): Promise<void> {
    // Check if file has actually changed
    const currentHash = await this.getFileHash(filepath);
    const lastTracked = await storage.getFileTracking(filepath);

    if (lastTracked && lastTracked.hash === currentHash) {
      return; // File hasn't actually changed
    }

    // Parse the file
    const parseResult = await this.symbolExtractor.extract(filepath);
    if (!parseResult) return;

    const metadata = await gitMetadata.getMetadata(filepath, currentHash);
    if (metadata) {
      for (const symbol of parseResult.symbols) {
        symbol.gitMetadata = metadata;
      }
    }

    // Remove old symbols
    const oldSymbols = await storage.getSymbolsByFile(filepath);
    for (const symbol of oldSymbols) {
      await storage.removeSymbol(symbol.id);
    }

    // Add new symbols
    await storage.addSymbols(parseResult.symbols);
    await storage.addDependencies(parseResult.dependencies);

    // Update file tracking
    const fileStat = await stat(filepath);
    await storage.setFileTracking(filepath, {
      mtime: fileStat.mtime.getTime(),
      hash: currentHash,
    });

    console.error(`Updated file: ${filepath} (${parseResult.symbols.length} symbols)`);
  }

  private async getFileHash(filepath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filepath, 'utf-8');
    return createHash('sha256').update(content).digest('hex');
  }
}
