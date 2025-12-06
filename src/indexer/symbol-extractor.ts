import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { parserFactory } from '../parsers/index.js';
import { ParseResult, Symbol, DependencyEdge, Location } from '../parsers/base.js';
import { FileScanner } from './file-scanner.js';
import { storage } from '../storage/index.js';

export interface ExtractionOptions {
  batchSize?: number;
  maxConcurrency?: number;
  includeDependencies?: boolean;
  deduplicateSymbols?: boolean;
  updateStorage?: boolean;
  onProgress?: (progress: ExtractionProgress) => void;
}

export interface ExtractionProgress {
  filesProcessed: number;
  totalFiles: number;
  symbolsFound: number;
  dependenciesFound: number;
  errors: Array<{ filepath: string; error: string }>;
  currentFile?: string;
}

export interface ExtractionStats {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  totalSymbols: number;
  totalDependencies: number;
  duplicateSymbols: number;
  processingTimeMs: number;
  errors: Array<{ filepath: string; error: string }>;
}

export interface ExtractedData {
  symbols: Symbol[];
  dependencies: DependencyEdge[];
  stats: ExtractionStats;
}

export class SymbolExtractor extends EventEmitter {
  private fileScanner: FileScanner;
  private symbolCache: Map<string, Symbol> = new Map();

  constructor() {
    super();
    this.fileScanner = new FileScanner();
  }

  /**
   * Extract symbols from a single file
   */
  async extract(filepath: string): Promise<ParseResult | null> {
    try {
      const content = await this.fileScanner.readFile(filepath);
      const extension = extname(filepath);
      const language = this.getLanguageFromExtension(extension);

      if (!language) {
        return null;
      }

      const parser = parserFactory.getParser(language);
      if (!parser) {
        console.warn(`No parser found for language: ${language}`);
        return null;
      }

      const result = await parser.parse(filepath, content);

      // Process symbols to ensure proper IDs and relationships
      result.symbols = this.processSymbols(result.symbols, filepath, language);

      // Process dependencies to ensure proper target resolution
      result.dependencies = this.processDependencies(result.dependencies, result.symbols, filepath);

      return result;
    } catch (error) {
      console.error(`Failed to extract symbols from ${filepath}:`, error);
      return null;
    }
  }

  /**
   * Extract symbols from multiple files in batch with parallel processing
   */
  async extractBatch(filepaths: string[], options: ExtractionOptions = {}): Promise<ExtractedData> {
    const startTime = Date.now();

    const {
      batchSize = 50,
      maxConcurrency = 10,
      includeDependencies = true,
      deduplicateSymbols = true,
      updateStorage = false,
      onProgress
    } = options;

    const stats: ExtractionStats = {
      totalFiles: filepaths.length,
      successfulFiles: 0,
      failedFiles: 0,
      totalSymbols: 0,
      totalDependencies: 0,
      duplicateSymbols: 0,
      processingTimeMs: 0,
      errors: []
    };

    const allSymbols: Symbol[] = [];
    const allDependencies: DependencyEdge[] = [];
    const seenSymbolIds = new Set<string>();

    // Process files in batches
    for (let i = 0; i < filepaths.length; i += batchSize) {
      const batch = filepaths.slice(i, i + batchSize);
      const batchPromises: Promise<void>[] = [];

      // Process batch with controlled concurrency
      for (const filepath of batch) {
        const promise = this.processFile(
          filepath,
          allSymbols,
          allDependencies,
          seenSymbolIds,
          stats,
          deduplicateSymbols,
          updateStorage
        );
        batchPromises.push(promise);

        // Limit concurrency
        if (batchPromises.length >= maxConcurrency) {
          await Promise.all(batchPromises);
          batchPromises.length = 0;
        }
      }

      // Wait for remaining promises in batch
      if (batchPromises.length > 0) {
        await Promise.all(batchPromises);
      }

      // Report progress
      if (onProgress) {
        const progress: ExtractionProgress = {
          filesProcessed: i + batch.length,
          totalFiles: filepaths.length,
          symbolsFound: stats.totalSymbols,
          dependenciesFound: stats.totalDependencies,
          errors: stats.errors
        };
        onProgress(progress);
      }

      // Emit batch completion event
      this.emit('batchComplete', {
        batchNumber: Math.floor(i / batchSize) + 1,
        totalBatches: Math.ceil(filepaths.length / batchSize),
        stats
      });
    }

    // Establish parent-child relationships after all symbols are collected
    this.establishRelationships(allSymbols);

    // Deduplicate dependencies
    const uniqueDependencies = this.deduplicateDependencies(allDependencies);
    stats.totalDependencies = uniqueDependencies.length;

    // Update storage if requested
    if (updateStorage && allSymbols.length > 0) {
      try {
        await storage.addSymbols(allSymbols);
        if (includeDependencies && uniqueDependencies.length > 0) {
          await storage.addDependencies(uniqueDependencies);
        }
      } catch (error) {
        console.error('Failed to update storage:', error);
        stats.errors.push({
          filepath: 'storage',
          error: error instanceof Error ? error.message : 'Unknown storage error'
        });
      }
    }

    stats.processingTimeMs = Date.now() - startTime;

    // Emit completion event
    this.emit('complete', { stats, symbols: allSymbols, dependencies: uniqueDependencies });

    return {
      symbols: allSymbols,
      dependencies: uniqueDependencies,
      stats
    };
  }

  /**
   * Process a single file and extract symbols/dependencies
   */
  private async processFile(
    filepath: string,
    allSymbols: Symbol[],
    allDependencies: DependencyEdge[],
    seenSymbolIds: Set<string>,
    stats: ExtractionStats,
    deduplicate: boolean,
    updateStorage: boolean
  ): Promise<void> {
    try {
      const result = await this.extract(filepath);

      if (!result) {
        stats.failedFiles++;
        stats.errors.push({
          filepath,
          error: 'No parse result returned'
        });
        return;
      }

      // Add symbols with deduplication
      for (const symbol of result.symbols) {
        if (!seenSymbolIds.has(symbol.id)) {
          seenSymbolIds.add(symbol.id);
          allSymbols.push(symbol);
          stats.totalSymbols++;
        } else if (deduplicate) {
          stats.duplicateSymbols++;
        }
      }

      // Add dependencies
      allDependencies.push(...result.dependencies);
      stats.totalDependencies += result.dependencies.length;

      stats.successfulFiles++;
    } catch (error) {
      stats.failedFiles++;
      stats.errors.push({
        filepath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Process symbols to ensure proper IDs and metadata
   */
  private processSymbols(symbols: Symbol[], filepath: string, language: string): Symbol[] {
    const processedSymbols: Symbol[] = [];
    const symbolMap = new Map<string, Symbol>();

    // First pass: assign IDs and collect symbols
    for (const symbol of symbols) {
      // Generate unique ID in format filepath:name:line
      const relativePath = relative(process.cwd(), filepath);
      const id = `${relativePath}:${symbol.name}:${symbol.location.start.line}`;

      const processed: Symbol = {
        ...symbol,
        id,
        filepath,
        language,
        children: []
      };

      processedSymbols.push(processed);
      symbolMap.set(symbol.name, processed);
    }

    // Second pass: establish parent-child relationships
    for (const symbol of processedSymbols) {
      if (symbol.parent) {
        const parentSymbol = symbolMap.get(symbol.parent);
        if (parentSymbol) {
          parentSymbol.children.push(symbol.id);
          symbol.parent = parentSymbol.id;
        }
      }
    }

    return processedSymbols;
  }

  /**
   * Process dependencies to ensure proper target resolution
   */
  private processDependencies(
    dependencies: DependencyEdge[],
    symbols: Symbol[],
    filepath: string
  ): DependencyEdge[] {
    const symbolMap = new Map<string, Symbol>();

    // Create symbol lookup map
    for (const symbol of symbols) {
      symbolMap.set(symbol.name, symbol);
      symbolMap.set(symbol.id, symbol);
    }

    const processedDependencies: DependencyEdge[] = [];

    for (const dep of dependencies) {
      const processed: DependencyEdge = {
        ...dep,
        // For import dependencies, 'from' is already a filepath, don't modify it
        // For other dependencies, 'from' might be a symbol name that needs to be converted to an ID
        from: dep.type === 'imports' ? dep.from : (dep.from.includes(':') ? dep.from : `${filepath}:${dep.from}:1`)
      };

      // Try to resolve target symbol
      let targetSymbol = symbolMap.get(dep.to);

      // If not found by name, try with ID
      if (!targetSymbol && dep.to.includes(':')) {
        targetSymbol = symbolMap.get(dep.to);
      }

      // For imports, keep the import path as is (will be resolved by DependencyResolver)
      // For other dependencies, resolve to symbol ID if found
      if (targetSymbol && dep.type !== 'imports') {
        processed.to = targetSymbol.id;
      }
      // Keep ALL dependencies, even unresolved ones
      // Cross-file imports will be resolved later by DependencyResolver
      processedDependencies.push(processed);
    }

    return processedDependencies;
  }

  /**
   * Establish parent-child relationships after all symbols are collected
   */
  private establishRelationships(symbols: Symbol[]): void {
    const symbolMap = new Map<string, Symbol>();

    // Build lookup map
    for (const symbol of symbols) {
      symbolMap.set(symbol.id, symbol);
    }

    // Process relationships
    for (const symbol of symbols) {
      if (symbol.parent) {
        const parent = symbolMap.get(symbol.parent);
        if (parent && !parent.children.includes(symbol.id)) {
          parent.children.push(symbol.id);
        }
      }
    }
  }

  /**
   * Deduplicate dependencies
   */
  private deduplicateDependencies(dependencies: DependencyEdge[]): DependencyEdge[] {
    const seen = new Set<string>();
    const unique: DependencyEdge[] = [];

    for (const dep of dependencies) {
      const key = `${dep.from}:${dep.to}:${dep.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(dep);
      }
    }

    return unique;
  }

  /**
   * Get language from file extension
   */
  private getLanguageFromExtension(extension: string): string | null {
    const extensionMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.hxx': 'cpp',
    };

    return extensionMap[extension] || null;
  }

  /**
   * Clear the symbol cache
   */
  clearCache(): void {
    this.symbolCache.clear();
  }

  /**
   * Get supported file extensions
   */
  getSupportedExtensions(): string[] {
    return Object.keys({
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.hxx': 'cpp',
    });
  }

  /**
   * Get supported languages
   */
  getSupportedLanguages(): string[] {
    return parserFactory.getSupportedLanguages();
  }
}