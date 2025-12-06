import { FileScanner, FileInfo, ScanResult } from './file-scanner.js';
import { SymbolExtractor, ExtractionOptions } from './symbol-extractor.js';
import { DependencyResolver } from './dependency-resolver.js';
import { Watcher } from './watcher.js';
import { storage } from '../storage/index.js';
import { config } from '../config.js';
import { gitMetadata } from '../git/metadata.js';
import type { Symbol } from '../parsers/base.js';

export interface IndexOptions {
  force?: boolean;
  incremental?: boolean;
  batchSize?: number;
  maxConcurrency?: number;
}

export interface IndexStats {
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  symbolsFound: number;
  dependenciesFound: number;
  timeMs: number;
  errors: Array<{ filepath: string; error: string }>;
}

export class Indexer {
  private fileScanner: FileScanner;
  private symbolExtractor: SymbolExtractor;
  private dependencyResolver: DependencyResolver;
  private watcher: Watcher;
  private isIndexing: boolean = false;
  private projectPath: string | null = null;

  constructor() {
    this.fileScanner = new FileScanner();
    this.symbolExtractor = new SymbolExtractor();
    this.dependencyResolver = new DependencyResolver();
    this.watcher = new Watcher();
  }

  async indexProject(projectPath: string, options: IndexOptions = {}): Promise<IndexStats> {
    if (this.isIndexing) {
      throw new Error('Indexing already in progress');
    }

    this.isIndexing = true;
    this.projectPath = projectPath;

    const startTime = Date.now();
    const stats: IndexStats = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      symbolsFound: 0,
      dependenciesFound: 0,
      timeMs: 0,
      errors: [],
    };

    try {
      console.error(`Starting ${options.incremental ? 'incremental' : 'full'} indexing for ${projectPath}`);

      // Get tracked files from storage
      const trackedFiles = await this.getTrackedFiles();

      // Determine if this is incremental or full indexing
      const isIncremental = options.incremental && !options.force && trackedFiles.size > 0;

      // Scan files
      let scanResult: ScanResult;
      if (isIncremental) {
        scanResult = await this.fileScanner.scan(projectPath, true, trackedFiles);
      } else {
        const fullScan = await this.fileScanner.scan(projectPath);
        scanResult = {
          files: fullScan.files.map(f => ({ ...f, hash: undefined })),
          changed: fullScan.files,
          deleted: [],
        };
      }

      // Handle deleted files
      if (scanResult.deleted.length > 0) {
        await this.handleDeletedFiles(scanResult.deleted);
        stats.filesDeleted = scanResult.deleted.length;
      }

      // Determine which files to process
      const filesToProcess = options.force ? scanResult.files : scanResult.changed;

      if (filesToProcess.length > 0) {
        // Process files in batches for better performance
        const extractionOptions: ExtractionOptions = {
          batchSize: options.batchSize || 50,
          maxConcurrency: options.maxConcurrency || 10,
          includeDependencies: true,
          deduplicateSymbols: true,
          updateStorage: false, // We'll update manually for better control
          onProgress: (progress) => {
            console.error(
              `Progress: ${progress.filesProcessed}/${progress.totalFiles} files, ` +
              `${progress.symbolsFound} symbols, ${progress.errors.length} errors`
            );
          }
        };

        const filePaths = filesToProcess.map(f => f.path);
        const extractionResult = await this.symbolExtractor.extractBatch(filePaths, extractionOptions);

        // Update stats
        stats.filesIndexed = extractionResult.stats.successfulFiles;
        stats.filesSkipped = extractionResult.stats.failedFiles;
        stats.symbolsFound = extractionResult.stats.totalSymbols;
        stats.dependenciesFound = extractionResult.stats.totalDependencies;
        stats.errors = extractionResult.stats.errors;

        await this.attachGitMetadata(extractionResult.symbols, filesToProcess);

        // Update storage in batches
        if (extractionResult.symbols.length > 0) {
          // For incremental updates, remove old symbols first
          if (isIncremental) {
            await this.removeOldSymbols(filePaths);
          }

          await storage.addSymbols(extractionResult.symbols);
        }

        // Resolve and store dependencies
        console.error(`Raw dependencies from parsers: ${extractionResult.dependencies.length}`);
        console.error(`Symbols extracted: ${extractionResult.symbols.length}`);

        if (extractionResult.dependencies.length > 0 || extractionResult.symbols.length > 0) {
          console.error('Resolving import dependencies...');

          // Resolve cross-file import dependencies
          const importDeps = await this.dependencyResolver.resolveCrossFileImports(
            extractionResult.dependencies,
            extractionResult.symbols
          );
          console.error(`Resolved ${importDeps.length} import dependencies`);

          // Resolve intra-file symbol dependencies (extends, implements, uses, etc.)
          const symbolDeps = await this.dependencyResolver.resolveDependencies(extractionResult.symbols);
          console.error(`Resolved ${symbolDeps.length} symbol dependencies`);

          const allDeps = [...importDeps, ...symbolDeps];

          if (allDeps.length > 0) {
            console.error(`Storing ${allDeps.length} resolved dependencies...`);
            await storage.addDependencies(allDeps);
          }
        }

        // Update file tracking info
        await this.updateFileTracking(filesToProcess);
      } else {
        console.error('No files to process');
        stats.filesSkipped = scanResult.files.length;
      }

      // Compute PageRank
      console.error('Computing PageRank scores...');
      await this.dependencyResolver.computePageRank();

      // Get total counts for metadata
      const allSymbols = await storage.getAllSymbols();
      const allDependencies = await storage.getAllDependencies();

      // Update project metadata
      await storage.updateProjectMetadata({
        root: projectPath,
        indexedAt: new Date().toISOString(),
        stats: {
          files: scanResult.files.length,
          symbols: allSymbols.length,
          edges: allDependencies.length,
        },
      });

      stats.timeMs = Date.now() - startTime;

      console.error(
        `Indexing complete: ${stats.filesIndexed} files processed, ` +
        `${stats.symbolsFound} symbols, ${stats.dependenciesFound} dependencies, ` +
        `${stats.errors.length} errors, ${stats.timeMs}ms`
      );

      // Setup watcher if enabled
      if (config.watcher.enabled && !options.incremental) {
        await this.watcher.start(projectPath);
      }

      return stats;
    } finally {
      this.isIndexing = false;
    }
  }

  async incrementalIndex(): Promise<IndexStats | null> {
    if (!this.projectPath) {
      throw new Error('No project has been indexed');
    }

    return this.indexProject(this.projectPath, { incremental: true });
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
  }

  private async getTrackedFiles(): Promise<Map<string, { mtime: number; hash: string }>> {
    const tracked = new Map<string, { mtime: number; hash: string }>();

    // Get all symbols to extract file paths
    const symbols = await storage.getAllSymbols();
    const filePaths = [...new Set(symbols.map(s => s.filepath))];

    // Get tracking info for each file
    for (const filepath of filePaths) {
      const tracking = await storage.getFileTracking(filepath);
      if (tracking) {
        tracked.set(filepath, tracking);
      }
    }

    return tracked;
  }

  private async handleDeletedFiles(deletedFiles: string[]): Promise<void> {
    for (const filepath of deletedFiles) {
      // Remove all symbols for this file
      const symbols = await storage.getSymbolsByFile(filepath);
      for (const symbol of symbols) {
        await storage.removeSymbol(symbol.id);
      }

      // Remove file tracking
      await storage.removeFileTracking(filepath);

      console.error(`Deleted file and its symbols: ${filepath}`);
    }
  }

  private async removeOldSymbols(filePaths: string[]): Promise<void> {
    for (const filepath of filePaths) {
      const symbols = await storage.getSymbolsByFile(filepath);
      for (const symbol of symbols) {
        await storage.removeSymbol(symbol.id);
      }
    }
  }

  private async updateFileTracking(files: FileInfo[]): Promise<void> {
    for (const file of files) {
      if (file.hash) {
        await storage.setFileTracking(file.path, {
          mtime: file.mtime,
          hash: file.hash,
        });
      }
    }
  }

  private async attachGitMetadata(symbols: Symbol[], files: FileInfo[]): Promise<void> {
    if (!config.git.enabled || symbols.length === 0 || files.length === 0) {
      return;
    }

    const metadataByFile = new Map<string, Awaited<ReturnType<typeof gitMetadata.getMetadata>>>();

    for (const file of files) {
      if (metadataByFile.has(file.path)) continue;

      try {
        const metadata = await gitMetadata.getMetadata(file.path, file.hash);
        metadataByFile.set(file.path, metadata);
      } catch (error) {
        console.error(`Failed to fetch git metadata for ${file.path}:`, error);
      }
    }

    for (const symbol of symbols) {
      const metadata = metadataByFile.get(symbol.filepath);
      if (metadata) {
        symbol.gitMetadata = metadata;
      }
    }
  }
}

export const indexer = new Indexer();
