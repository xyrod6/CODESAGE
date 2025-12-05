import Parser from 'tree-sitter';
import go from 'tree-sitter-go';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';

interface SymbolContext {
  filepath: string;
  content: string;
  imports: Map<string, string>; // alias -> module
  currentPackage?: string;
}

export class GoParser extends BaseParser {
  private parser: Parser;
  private language: any;

  constructor() {
    super();
    this.parser = new Parser();
    this.language = go;
    this.parser.setLanguage(this.language);
  }

  async parse(filepath: string, content: string): Promise<ParseResult> {
    const tree = this.parser.parse(content);
    const symbols: Symbol[] = [];
    const dependencies: DependencyEdge[] = [];

    const context: SymbolContext = {
      filepath,
      content,
      imports: new Map(),
    };

    // Walk the tree to extract symbols
    this.walkNode(tree.rootNode, context, symbols, dependencies);

    return {
      symbols,
      dependencies,
      language: this.getLanguage(),
    };
  }

  private walkNode(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[], dependencies: DependencyEdge[], parent?: Symbol): void {
    // Extract comment before this node
    const docstring = this.extractComment(node, context.content);

    switch (node.type) {
      case 'source_file':
        // Extract package declaration
        for (const child of node.children) {
          if (child.type === 'package_clause') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
              context.currentPackage = nameNode.text;
            }
          }
          // Process other top-level declarations
          this.walkNode(child, context, symbols, dependencies, parent);
        }
        break;

      case 'type_declaration':
        const typeSpec = node.childForFieldName('type_spec');
        if (typeSpec) {
          const typeSymbol = this.extractType(typeSpec, context, docstring, parent);
          if (typeSymbol) symbols.push(typeSymbol);
        }
        break;

      case 'function_declaration':
        const funcSymbol = this.extractFunction(node, context, docstring, parent);
        if (funcSymbol) {
          symbols.push(funcSymbol);

          // Process function body for local variables
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'short_var_declaration') {
                const varSymbol = this.extractShortVar(child, context, funcSymbol);
                if (varSymbol) symbols.push(varSymbol);
              }
            }
          }
        }
        break;

      case 'method_declaration':
        const methodSymbol = this.extractMethod(node, context, docstring, parent);
        if (methodSymbol) {
          symbols.push(methodSymbol);
        }
        break;

      case 'var_declaration':
        const varSymbols = this.extractVarDeclaration(node, context, parent);
        symbols.push(...varSymbols);
        break;

      case 'const_declaration':
        const constSymbols = this.extractConstDeclaration(node, context, parent);
        symbols.push(...constSymbols);
        break;

      case 'import_declaration':
        this.extractImport(node, context, dependencies);
        break;

      case 'import_spec_list':
        // Process each import spec
        for (const child of node.children) {
          if (child.type === 'import_spec') {
            this.extractImportSpec(child, context, dependencies);
          }
        }
        break;
    }

    // Recursively process children
    for (const child of node.children) {
      // Skip nodes we already processed
      if (node.type === 'source_file') continue;
      if (node.type === 'type_declaration' && child.type === 'type_spec') continue;
      if (node.type === 'function_declaration' && child.type === 'block') continue;
      if (node.type === 'method_declaration' && child.type === 'block') continue;
      if (node.type === 'import_declaration' && child.type === 'import_spec_list') continue;

      this.walkNode(child, context, symbols, dependencies, parent);
    }
  }

  private extractType(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = node.childForFieldName('type');
    let signature = `type ${name}`;
    if (typeNode) {
      signature += ` ${typeNode.text}`;
    }

    // Determine if it's a struct or interface
    const kind = typeNode?.type === 'struct_type' ? 'class' :
                 typeNode?.type === 'interface_type' ? 'interface' : 'type';

    return {
      id,
      name,
      kind,
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      // In Go, exported names start with capital letter
      exported: name[0] === name[0].toUpperCase(),
      language: this.getLanguage(),
    };
  }

  private extractFunction(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const parametersNode = node.childForFieldName('parameters');
    const resultNode = node.childForFieldName('result');

    let signature = `func ${name}(${parametersNode?.text || ''})`;
    if (resultNode) {
      signature += ` ${resultNode.text}`;
    }

    return {
      id,
      name,
      kind: 'function',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      exported: name[0] === name[0].toUpperCase(),
      language: this.getLanguage(),
    };
  }

  private extractMethod(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const receiverNode = node.childForFieldName('receiver');
    const parametersNode = node.childForFieldName('parameters');
    const resultNode = node.childForFieldName('result');

    let signature = `func `;
    if (receiverNode) {
      signature += `${receiverNode.text} `;
    }
    signature += `${name}(${parametersNode?.text || ''})`;
    if (resultNode) {
      signature += ` ${resultNode.text}`;
    }

    return {
      id,
      name,
      kind: 'method',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      exported: name[0] === name[0].toUpperCase(),
      language: this.getLanguage(),
    };
  }

  private extractVarDeclaration(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol[] {
    const symbols: Symbol[] = [];

    for (const child of node.children) {
      if (child.type === 'var_spec') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const id = `${context.filepath}:${name}:${node.startPosition.row}`;

          const typeNode = child.childForFieldName('type');
          const valueNode = child.childForFieldName('value');

          let signature = `var ${name}`;
          if (typeNode) {
            signature += ` ${typeNode.text}`;
          }
          if (valueNode) {
            signature += ` = ${valueNode.text}`;
          }

          symbols.push({
            id,
            name,
            kind: 'variable',
            filepath: context.filepath,
            location: {
              start: { line: child.startPosition.row + 1, column: child.startPosition.column },
              end: { line: child.endPosition.row + 1, column: child.endPosition.column },
            },
            signature,
            docstring: undefined,
            parent: parent?.id,
            children: [],
            exported: name[0] === name[0].toUpperCase(),
            language: this.getLanguage(),
          });
        }
      }
    }

    return symbols;
  }

  private extractConstDeclaration(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol[] {
    const symbols: Symbol[] = [];

    for (const child of node.children) {
      if (child.type === 'const_spec') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          const name = nameNode.text;
          const id = `${context.filepath}:${name}:${node.startPosition.row}`;

          const typeNode = child.childForFieldName('type');
          const valueNode = child.childForFieldName('value');

          let signature = `const ${name}`;
          if (typeNode) {
            signature += ` ${typeNode.text}`;
          }
          if (valueNode) {
            signature += ` = ${valueNode.text}`;
          }

          symbols.push({
            id,
            name,
            kind: 'constant',
            filepath: context.filepath,
            location: {
              start: { line: child.startPosition.row + 1, column: child.startPosition.column },
              end: { line: child.endPosition.row + 1, column: child.endPosition.column },
            },
            signature,
            docstring: undefined,
            parent: parent?.id,
            children: [],
            exported: name[0] === name[0].toUpperCase(),
            language: this.getLanguage(),
          });
        }
      }
    }

    return symbols;
  }

  private extractShortVar(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol[] {
    const symbols: Symbol[] = [];

    const left = node.childForFieldName('left');
    if (left && left.type === 'identifier_list') {
      for (const child of left.children) {
        if (child.type === 'identifier') {
          const name = child.text;
          const id = `${context.filepath}:${name}:${node.startPosition.row}`;

          symbols.push({
            id,
            name,
            kind: 'variable',
            filepath: context.filepath,
            location: {
              start: { line: node.startPosition.row + 1, column: node.startPosition.column },
              end: { line: node.endPosition.row + 1, column: node.endPosition.column },
            },
            signature: node.text,
            docstring: undefined,
            parent: parent?.id,
            children: [],
            exported: false, // Short vars are never exported
            language: this.getLanguage(),
          });
        }
      }
    }

    return symbols;
  }

  private extractImport(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const pathNode = node.childForFieldName('path');
    if (pathNode) {
      const importPath = pathNode.text.replace(/["']/g, '');

      dependencies.push({
        from: context.filepath,
        to: importPath,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractImportSpec(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const nameNode = node.childForFieldName('name');
    const pathNode = node.childForFieldName('path');

    if (pathNode) {
      const importPath = pathNode.text.replace(/["']/g, '');

      // Handle alias
      if (nameNode && nameNode.type === 'identifier') {
        context.imports.set(nameNode.text, importPath);
      }

      dependencies.push({
        from: context.filepath,
        to: importPath,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractComment(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for comments before this node
    const lines = content.split('\n');
    const startLine = node.startPosition.row;

    // Check previous lines for comments
    for (let i = startLine - 1; i >= 0; i--) {
      const line = lines[i].trim();

      // If we hit a non-comment line, stop searching
      if (line && !line.startsWith('//')) {
        break;
      }

      // Check for godoc format
      if (line.startsWith('//')) {
        // Collect the full comment block
        const commentLines: string[] = [];
        for (let j = i; j >= 0; j--) {
          const currentLine = lines[j].trim();
          if (!currentLine.startsWith('//')) break;
          commentLines.unshift(currentLine.substring(2).trim());
        }

        // Join and clean up the comment
        const comment = commentLines.join('\n').trim();
        if (comment) return comment;
      }
    }

    return undefined;
  }

  getSupportedExtensions(): string[] {
    return ['.go'];
  }

  getLanguage(): string {
    return 'go';
  }
}