import { Parser } from './base.js';
import { TypeScriptParser } from './languages/typescript.js';
import { PythonParser } from './languages/python.js';
import { GoParser } from './languages/go.js';
import { RustParser } from './languages/rust.js';
import { JavaParser } from './languages/java.js';
import { CppParser } from './languages/cpp.js';

export type { Parser } from './base.js';
export { TypeScriptParser, PythonParser, GoParser, RustParser, JavaParser, CppParser };

export class ParserFactory {
  private parsers: Map<string, Parser> = new Map();

  constructor() {
    this.parsers.set('typescript', new TypeScriptParser());
    this.parsers.set('javascript', new TypeScriptParser());
    this.parsers.set('tsx', new TypeScriptParser());
    this.parsers.set('jsx', new TypeScriptParser());
    this.parsers.set('python', new PythonParser());
    this.parsers.set('go', new GoParser());
    this.parsers.set('rust', new RustParser());
    this.parsers.set('java', new JavaParser());
    this.parsers.set('c', new CppParser());
    this.parsers.set('cpp', new CppParser());
  }

  getParser(language: string): Parser | undefined {
    return this.parsers.get(language);
  }

  getSupportedLanguages(): string[] {
    return Array.from(this.parsers.keys());
  }
}

export const parserFactory = new ParserFactory();