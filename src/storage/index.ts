import { Storage as RedisStorage } from './redis.js';
import { Symbol, DependencyEdge } from '../parsers/base.js';
import { FileTracking, ProjectMetadata } from './types.js';

export interface IStorage {
  initialize(): Promise<void>;
  close(): Promise<void>;
  setProjectContext(projectPath: string): Promise<void>;
  addSymbols(symbols: Symbol[]): Promise<void>;
  getSymbol(id: string): Promise<Symbol | null>;
  getSymbolsByFile(filepath: string): Promise<Symbol[]>;
  removeSymbol(id: string): Promise<void>;
  addDependencies(dependencies: DependencyEdge[]): Promise<void>;
  getDependenciesFrom(id: string): Promise<DependencyEdge[]>;
  getDependenciesTo(id: string): Promise<DependencyEdge[]>;
  getAllSymbols(): Promise<Symbol[]>;
  getAllDependencies(): Promise<DependencyEdge[]>;
  setPageRanks(ranks: Map<string, number>): Promise<void>;
  getPageRanks(): Promise<Map<string, number>>;
  setFileTracking(filepath: string, tracking: FileTracking): Promise<void>;
  getFileTracking(filepath: string): Promise<FileTracking | null>;
  removeFileTracking(filepath: string): Promise<void>;
  updateProjectMetadata(metadata: ProjectMetadata): Promise<void>;
  getProjectMetadata(): Promise<ProjectMetadata | null>;
  acquireLock(lockName: string, ttlMs?: number): Promise<boolean>;
  releaseLock(lockName: string): Promise<void>;
}

export const storage: IStorage = new RedisStorage();
export type { FileTracking, ProjectMetadata } from './types.js';