import { indexProject } from './index-project.js';
import { getSymbol } from './get-symbol.js';
import { searchSymbols } from './search-symbols.js';
import { getFileStructure } from './get-file-structure.js';
import { getProjectOverview } from './get-project-overview.js';
import { getDependencies } from './get-dependencies.js';
import { getDependents } from './get-dependents.js';
import { getImpact } from './get-impact.js';
import { findSimilar } from './find-similar.js';
import { getSymbolHistory } from './get-symbol-history.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<any>;
}

export const tools: Tool[] = [
  indexProject,
  getSymbol,
  searchSymbols,
  getFileStructure,
  getProjectOverview,
  getDependencies,
  getDependents,
  getImpact,
  getSymbolHistory,
  findSimilar,
];

export {
  indexProject,
  getSymbol,
  searchSymbols,
  getFileStructure,
  getProjectOverview,
  getDependencies,
  getDependents,
  getImpact,
  getSymbolHistory,
  findSimilar,
};
