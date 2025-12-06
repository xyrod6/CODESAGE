import tsModule from 'tree-sitter-typescript';
import Parser from 'tree-sitter';
import { extname } from 'node:path';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind, DependencyType } from '../base.js';
import { getChildForFieldName, getNodeText, findDescendantOfType, getChildrenOfType } from '../utils.js';

interface SymbolContext {
  filepath: string;
  content: string;
  exports: Set<string>;
  imports: Map<string, string>;
}

export class TypeScriptParser extends BaseParser {
  private parser: Parser;
  private tsLanguage: any;
  private tsxLanguage: any;
  private isTSX: boolean = false;
  private currentLanguage: string = 'typescript';

  constructor() {
    super();
    this.parser = new Parser();
    this.tsLanguage = tsModule.typescript;
    this.tsxLanguage = tsModule.tsx;

    // Initialize with TypeScript by default
    this.parser.setLanguage(this.tsLanguage);
  }

  async parse(filepath: string, content: string): Promise<ParseResult> {
    // Determine if we should use TSX parser
    const extension = extname(filepath).toLowerCase();
    this.isTSX = extension === '.tsx' || extension === '.jsx';
    const isJavaScript = extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs';
    this.currentLanguage = isJavaScript ? 'javascript' : 'typescript';

    if (this.isTSX) {
      this.parser.setLanguage(this.tsxLanguage);
    } else {
      this.parser.setLanguage(this.tsLanguage);
    }

    const tree = this.parser.parse(content);
    const symbols: Symbol[] = [];
    const dependencies: DependencyEdge[] = [];

    const context: SymbolContext = {
      filepath,
      content,
      exports: new Set(),
      imports: new Map()
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
    // Extract JSDoc comments before this node
    const docstring = this.extractJSDoc(node, context.content);
    const exportDeclaration = node.type === 'export_statement'
      ? getChildForFieldName(node, 'declaration')
      : null;

    // Handle different node types
    switch (node.type) {
      case 'class_declaration':
      case 'class_expression':
        const classSymbol = this.extractClass(node, context, docstring, parent);
        if (classSymbol) {
          symbols.push(classSymbol);

          // Process class body
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              this.walkNode(child, context, symbols, dependencies, classSymbol);
            }
          }
        }
        break;

      case 'interface_declaration':
        const interfaceSymbol = this.extractInterface(node, context, docstring, parent);
        if (interfaceSymbol) {
          symbols.push(interfaceSymbol);

          // Process interface body
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'property_signature') {
                const propSymbol = this.extractInterfaceProperty(child, context, interfaceSymbol);
                if (propSymbol) symbols.push(propSymbol);
              }
            }
          }
        }
        break;

      case 'type_alias_declaration':
        const typeSymbol = this.extractTypeAlias(node, context, docstring, parent);
        if (typeSymbol) {
          symbols.push(typeSymbol);
        }
        break;

      case 'enum_declaration':
        const enumSymbol = this.extractEnum(node, context, docstring, parent);
        if (enumSymbol) {
          symbols.push(enumSymbol);

          // Process enum members
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'property_identifier') {
                const memberSymbol = this.extractEnumMember(child, context, enumSymbol);
                if (memberSymbol) symbols.push(memberSymbol);
              }
            }
          }
        }
        break;

      case 'function_declaration':
        const funcSymbol = this.extractFunction(node, context, docstring, parent);
        if (funcSymbol) {
          symbols.push(funcSymbol);
        }
        break;

      case 'lexical_declaration':
      case 'variable_declaration':
        for (const child of node.children) {
          if (child.type === 'variable_declarator') {
            const value = getChildForFieldName(child, 'value');
            if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
              const arrowFuncSymbol = this.extractVariableFunction(child, context, docstring, parent);
              if (arrowFuncSymbol) symbols.push(arrowFuncSymbol);
            } else {
              const varSymbol = this.extractVariable(child, context, docstring, parent);
              if (varSymbol) symbols.push(varSymbol);
            }
          }
        }
        break;

      case 'method_definition':
        if (parent) {
          const methodSymbol = this.extractMethod(node, context, parent);
          if (methodSymbol) symbols.push(methodSymbol);
        }
        break;

      case 'public_field_definition':
        if (parent) {
          const fieldSymbol = this.extractField(node, context, parent);
          if (fieldSymbol) symbols.push(fieldSymbol);
        }
        break;

      case 'module_declaration':
      case 'namespace_declaration':
        const namespaceSymbol = this.extractNamespace(node, context, docstring, parent);
        if (namespaceSymbol) {
          symbols.push(namespaceSymbol);

          // Process namespace body
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              this.walkNode(child, context, symbols, dependencies, namespaceSymbol);
            }
          }
        }
        break;

      case 'export_statement':
        if (exportDeclaration) {
          this.walkNode(exportDeclaration, context, symbols, dependencies, parent);
        }
        return;

      case 'import_statement':
        this.extractImport(node, context, dependencies);
        break;
    }

    // Recursively process children for any nodes we didn't handle
    for (const child of node.children) {
      // Skip nodes we already processed
      if (node.type === 'class_declaration' && child.type === 'class_body') continue;
      if (node.type === 'interface_declaration' && child.type === 'object_type') continue;
      if (node.type === 'enum_declaration' && child.type === 'enum_body') continue;
      if (node.type === 'module_declaration' && child.type === 'statement_block') continue;
      if (
        exportDeclaration &&
        child.startIndex === exportDeclaration.startIndex &&
        child.endIndex === exportDeclaration.endIndex
      ) continue;

      this.walkNode(child, context, symbols, dependencies, parent);
    }
  }

  private extractClass(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'class',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: getNodeText(node, context.content),
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractInterface(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'interface',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: getNodeText(node, context.content),
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractTypeAlias(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'type',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: getNodeText(node, context.content),
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractEnum(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'enum',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: getNodeText(node, context.content),
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractFunction(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'function',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: getNodeText(node, context.content),
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractMethod(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    return {
      id,
      name,
      kind: 'method',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: getNodeText(node, context.content),
      docstring: this.extractJSDoc(node, context.content),
      parent: parent.id,
      children: [],
      exported: false,
      language: this.getLanguage(),
    };
  }

  private extractField(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');

    return {
      id,
      name,
      kind: 'property',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `${name}${typeNode ? `: ${getNodeText(typeNode, context.content)}` : ''}`,
      docstring: this.extractJSDoc(node, context.content),
      parent: parent.id,
      children: [],
      exported: false,
      language: this.getLanguage(),
    };
  }

  private extractInterfaceProperty(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');

    return {
      id,
      name,
      kind: 'property',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `${name}${typeNode ? `: ${getNodeText(typeNode, context.content)}` : ''}`,
      docstring: this.extractJSDoc(node, context.content),
      parent: parent.id,
      children: [],
      exported: false,
      language: this.getLanguage(),
    };
  }

  private extractEnumMember(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const name = getNodeText(node, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    return {
      id,
      name,
      kind: 'constant',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: name,
      docstring: undefined,
      parent: parent.id,
      children: [],
      exported: parent.exported,
      language: this.getLanguage(),
    };
  }

  private extractVariableFunction(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const valueNode = getChildForFieldName(node, 'value');
    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'function',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: valueNode ? getNodeText(valueNode, context.content) : getNodeText(node, context.content),
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractVariable(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');
    const isExported = node.parent?.type === 'export_statement';

    // Determine if it's a constant (const) or variable (let/var)
    const kind = (node.parent?.type === 'lexical_declaration' &&
                  node.parent.children[0]?.text === 'const') ? 'constant' : 'variable';

    return {
      id,
      name,
      kind,
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `${name}${typeNode ? `: ${getNodeText(typeNode, context.content)}` : ''}`,
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractNamespace(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const isExported = node.parent?.type === 'export_statement';

    return {
      id,
      name,
      kind: 'namespace',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `namespace ${name}`,
      docstring,
      parent: parent?.id,
      children: [],
      exported: isExported,
      language: this.getLanguage(),
    };
  }

  private extractImport(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const sourceNode = getChildForFieldName(node, 'source');
    if (sourceNode) {
      const source = getNodeText(sourceNode, context.content).replace(/['"]/g, '');

      dependencies.push({
        from: context.filepath,
        to: source,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractJSDoc(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for JSDoc comments before this node
    const lines = content.split('\n');
    const startLine = node.startPosition.row;

    // Check previous lines for JSDoc
    for (let i = startLine - 1; i >= 0; i--) {
      const line = lines[i].trim();

      // If we hit a non-comment line, stop searching
      if (line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
        break;
      }

      // Check for JSDoc format
      if (line.startsWith('/**')) {
        // Collect the full JSDoc comment
        const jsdocLines: string[] = [];
        for (let j = i; j < lines.length; j++) {
          const currentLine = lines[j].trim();
          jsdocLines.push(currentLine);

          if (currentLine.endsWith('*/')) {
            break;
          }
        }

        // Clean up the JSDoc and return it
        return jsdocLines
          .map(l => l.replace(/^\s*[\/\*]+\s?/, '').replace(/\s*\*\/$/, ''))
          .filter(l => l || l === '')
          .join('\n');
      }
    }

    return undefined;
  }

  getSupportedExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  }

  getLanguage(): string {
    return this.currentLanguage;
  }
}
