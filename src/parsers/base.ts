export interface Location {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'constructor'
  | 'variable'
  | 'constant'
  | 'property'
  | 'module'
  | 'namespace';

export type DependencyType =
  | 'imports'
  | 'extends'
  | 'implements'
  | 'calls'
  | 'uses'
  | 'instantiates';

import type { GitMetadata } from '../git/metadata';

export interface Symbol {
  id: string;
  name: string;
  kind: SymbolKind;
  filepath: string;
  location: Location;
  signature?: string;
  docstring?: string;
  parent?: string;
  children: string[];
  exported: boolean;
  language: string;
  gitMetadata?: GitMetadata;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: DependencyType;
  location?: Location;
}

export interface ParseResult {
  symbols: Symbol[];
  dependencies: DependencyEdge[];
  language: string;
}

export abstract class Parser {
  abstract parse(filepath: string, content: string): Promise<ParseResult>;
  abstract getSupportedExtensions(): string[];
  abstract getLanguage(): string;
}
