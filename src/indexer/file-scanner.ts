import fastGlob from 'fast-glob';
const { glob } = fastGlob;
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { config } from '../config.js';
import micromatch from 'micromatch';
import { createHash } from 'node:crypto';

export interface FileInfo {
  path: string;
  mtime: number;
  size: number;
  hash?: string;
}

export interface ScanResult {
  files: FileInfo[];
  changed: FileInfo[];
  deleted: string[];
}

export class FileScanner {
  async scan(projectPath: string, incremental: boolean = false, trackedFiles?: Map<string, { mtime: number; hash: string }>): Promise<ScanResult> {
    const patterns = config.indexer.include.map(p => join(projectPath, p));

    // Get all files matching patterns
    const allFiles = await glob(patterns, {
      cwd: projectPath,
      absolute: true,
      onlyFiles: true,
      stats: true,
    });

    // Filter by exclude patterns and size, and collect file info
    const validFiles: FileInfo[] = [];
    const changedFiles: FileInfo[] = [];
    const deletedFiles: string[] = [];

    for (const fileEntry of allFiles) {
      // fileEntry can be a string or an object with stats
      let filePath: string;
      let fileStat: any;

      if (typeof fileEntry === 'string') {
        filePath = fileEntry;
        fileStat = await stat(filePath);
      } else {
        filePath = fileEntry.path;
        fileStat = fileEntry.stats;
      }

      const relativePath = relative(projectPath, filePath);

      // Skip if matches exclude patterns
      if (micromatch.isMatch(relativePath, config.indexer.exclude)) {
        continue;
      }

      // Skip if file is too large
      if (fileStat.size > config.indexer.maxFileSize) {
        continue;
      }

      const fileInfo: FileInfo = {
        path: filePath,
        mtime: fileStat.mtime.getTime(),
        size: fileStat.size,
      };

      validFiles.push(fileInfo);

      // For incremental mode, check if file has changed
      if (incremental && trackedFiles) {
        const tracked = trackedFiles.get(filePath);
        if (!tracked || tracked.mtime !== fileStat.mtime.getTime()) {
          // File is new or modified, compute hash
          fileInfo.hash = await this.getFileHash(filePath);
          changedFiles.push(fileInfo);
        }
      }
    }

    // For incremental mode, find deleted files
    if (incremental && trackedFiles) {
      const currentFilePaths = new Set(validFiles.map(f => f.path));
      for (const [trackedPath] of trackedFiles) {
        if (!currentFilePaths.has(trackedPath)) {
          deletedFiles.push(trackedPath);
        }
      }
    }

    return {
      files: validFiles,
      changed: changedFiles,
      deleted: deletedFiles,
    };
  }

  async readFile(filepath: string): Promise<string> {
    return await readFile(filepath, 'utf-8');
  }

  async getFileHash(filepath: string): Promise<string> {
    try {
      const fileStat = await stat(filepath);

      // Skip hash computation for very large files
      if (fileStat.size > 1024 * 1024) { // 1MB
        return createHash('sha256').update(filepath).update(fileStat.mtime.getTime().toString()).digest('hex');
      }

      const content = await readFile(filepath, 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch (error) {
      // If we can't read the file (e.g., binary file), use file metadata
      try {
        const fileStat = await stat(filepath);
        return createHash('sha256').update(filepath).update(fileStat.mtime.getTime().toString()).update(fileStat.size.toString()).digest('hex');
      } catch {
        // If even stat fails, return empty hash
        return '';
      }
    }
  }

  async getFileInfo(filepath: string): Promise<FileInfo | null> {
    try {
      const fileStat = await stat(filepath);
      return {
        path: filepath,
        mtime: fileStat.mtime.getTime(),
        size: fileStat.size,
        hash: await this.getFileHash(filepath),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Scan a directory efficiently with parallel stat calls
   */
  async scanParallel(projectPath: string, concurrency: number = 50): Promise<FileInfo[]> {
    const patterns = config.indexer.include.map(p => join(projectPath, p));

    // Get all file paths first
    const filePaths = await glob(patterns, {
      cwd: projectPath,
      absolute: true,
      onlyFiles: true,
    });

    // Filter by exclude patterns
    const filteredFiles = filePaths.filter(file => {
      const relativePath = relative(projectPath, file);
      return !micromatch.isMatch(relativePath, config.indexer.exclude);
    });

    // Process files in batches to check stats
    const validFiles: FileInfo[] = [];
    const chunks: string[][] = [];

    for (let i = 0; i < filteredFiles.length; i += concurrency) {
      chunks.push(filteredFiles.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (file) => {
        try {
          const fileStat = await stat(file);
          if (fileStat.size <= config.indexer.maxFileSize) {
            return {
              path: file,
              mtime: fileStat.mtime.getTime(),
              size: fileStat.size,
            } as FileInfo;
          }
          return null;
        } catch {
          return null;
        }
      });

      const results = await Promise.all(promises);
      for (const result of results) {
        if (result) {
          validFiles.push(result);
        }
      }
    }

    return validFiles;
  }
}