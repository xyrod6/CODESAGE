export interface FileTracking {
  mtime: number;
  hash: string;
}

export interface ProjectMetadata {
  root: string;
  indexedAt: string;
  stats: {
    files: number;
    symbols: number;
    edges: number;
  };
}