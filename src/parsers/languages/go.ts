import Parser from 'tree-sitter';
import goModule from 'tree-sitter-go';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';
import { getChildForFieldName, getNodeText, findDescendantOfType, getChildrenOfType } from '../utils.js';

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
    this.language = goModule;
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
            const nameNode = getChildForFieldName(child, 'name');
            if (nameNode) {
              context.currentPackage = getNodeText(nameNode, context.content);
            }
          }
          // Process other top-level declarations
          this.walkNode(child, context, symbols, dependencies, parent);
        }
        break;

      case 'type_declaration':
        const typeSpec = getChildForFieldName(node, 'type_spec');
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
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'short_var_declaration') {
                const varSymbols = this.extractShortVar(child, context, funcSymbol);
                symbols.push(...varSymbols);
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
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');
    let signature = `type ${name}`;
    if (typeNode) {
      signature += ` ${getNodeText(typeNode, context.content)}`;
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
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const parametersNode = getChildForFieldName(node, 'parameters');
    const resultNode = getChildForFieldName(node, 'result');

    let signature = `func ${name}(${parametersNode ? getNodeText(parametersNode, context.content) : ''})`;
    if (resultNode) {
      signature += ` ${getNodeText(resultNode, context.content)}`;
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
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const receiverNode = getChildForFieldName(node, 'receiver');
    const parametersNode = getChildForFieldName(node, 'parameters');
    const resultNode = getChildForFieldName(node, 'result');

    let signature = `func `;
    if (receiverNode) {
      signature += `${getNodeText(receiverNode, context.content)} `;
    }
    signature += `${name}(${parametersNode ? getNodeText(parametersNode, context.content) : ''})`;
    if (resultNode) {
      signature += ` ${getNodeText(resultNode, context.content)}`;
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
        const nameNode = getChildForFieldName(child, 'name');
        if (nameNode) {
          const name = getNodeText(nameNode, context.content);
          const id = `${context.filepath}:${name}:${node.startPosition.row}`;

          const typeNode = getChildForFieldName(child, 'type');
          const valueNode = getChildForFieldName(child, 'value');

          let signature = `var ${name}`;
          if (typeNode) {
            signature += ` ${getNodeText(typeNode, context.content)}`;
          }
          if (valueNode) {
            signature += ` = ${getNodeText(valueNode, context.content)}`;
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
        const nameNode = getChildForFieldName(child, 'name');
        if (nameNode) {
          const name = getNodeText(nameNode, context.content);
          const id = `${context.filepath}:${name}:${node.startPosition.row}`;

          const typeNode = getChildForFieldName(child, 'type');
          const valueNode = getChildForFieldName(child, 'value');

          let signature = `const ${name}`;
          if (typeNode) {
            signature += ` ${getNodeText(typeNode, context.content)}`;
          }
          if (valueNode) {
            signature += ` = ${getNodeText(valueNode, context.content)}`;
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

    const left = getChildForFieldName(node, 'left');
    if (left && left.type === 'identifier_list') {
      for (const child of left.children) {
        if (child.type === 'identifier') {
          const name = getNodeText(child, context.content);
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
            signature: getNodeText(node, context.content),
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
    const pathNode = getChildForFieldName(node, 'path');
    if (pathNode) {
      const importPath = getNodeText(pathNode, context.content).replace(/["']/g, '');

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
    const nameNode = getChildForFieldName(node, 'name');
    const pathNode = getChildForFieldName(node, 'path');

    if (pathNode) {
      const importPath = getNodeText(pathNode, context.content).replace(/["']/g, '');

      // Handle alias
      if (nameNode && nameNode.type === 'identifier') {
        context.imports.set(getNodeText(nameNode, context.content), importPath);
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