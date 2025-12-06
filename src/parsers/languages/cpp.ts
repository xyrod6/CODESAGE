import Parser from 'tree-sitter';
import cppModule from 'tree-sitter-cpp';
import cModule from 'tree-sitter-c';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';
import { getChildForFieldName, getNodeText, findDescendantOfType, getChildrenOfType } from '../utils.js';

interface SymbolContext {
  filepath: string;
  content: string;
  includes: Set<string>;
  currentNamespace?: string;
  currentClass?: string;
}

export class CppParser extends BaseParser {
  private parser: Parser;
  private cLanguage: any;
  private cppLanguage: any;
  private isCppFile: boolean;

  constructor() {
    super();
    this.parser = new Parser();
    this.cLanguage = cModule;
    this.cppLanguage = cppModule;
    this.isCppFile = false;
  }

  async parse(filepath: string, content: string): Promise<ParseResult> {
    // Determine which parser to use based on file extension
    this.isCppFile = filepath.endsWith('.cpp') || filepath.endsWith('.cxx') ||
                    filepath.endsWith('.cc') || filepath.endsWith('.hpp') ||
                    filepath.endsWith('.hxx');

    this.parser.setLanguage(this.isCppFile ? this.cppLanguage : this.cLanguage);

    const tree = this.parser.parse(content);
    const symbols: Symbol[] = [];
    const dependencies: DependencyEdge[] = [];

    const context: SymbolContext = {
      filepath,
      content,
      includes: new Set(),
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
      case 'translation_unit':
        // Process all top-level declarations
        for (const child of node.children) {
          this.walkNode(child, context, symbols, dependencies);
        }
        break;

      case 'namespace_definition':
        const namespaceSymbol = this.extractNamespace(node, context, docstring, parent);
        if (namespaceSymbol) {
          symbols.push(namespaceSymbol);
          context.currentNamespace = namespaceSymbol.name;

          // Process namespace body
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              this.walkNode(child, context, symbols, dependencies, namespaceSymbol);
            }
          }
          context.currentNamespace = undefined;
        }
        break;

      case 'class_specifier':
      case 'struct_specifier':
        const classSymbol = this.extractClassOrStruct(node, context, docstring, parent);
        if (classSymbol) {
          symbols.push(classSymbol);
          context.currentClass = classSymbol.name;

          // Process class body
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'field_declaration' ||
                  child.type === 'function_definition' ||
                  child.type === 'declaration') {
                this.walkNode(child, context, symbols, dependencies, classSymbol);
              }
            }
          }
          context.currentClass = undefined;
        }
        break;

      case 'union_specifier':
        const unionSymbol = this.extractUnion(node, context, docstring, parent);
        if (unionSymbol) {
          symbols.push(unionSymbol);

          // Process union body
          const body = getChildForFieldName(node, 'body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'field_declaration') {
                this.walkNode(child, context, symbols, dependencies, unionSymbol);
              }
            }
          }
        }
        break;

      case 'function_definition':
        const funcSymbol = this.extractFunction(node, context, docstring, parent);
        if (funcSymbol) {
          symbols.push(funcSymbol);

          // Process function body for local variables
          const body = getChildForFieldName(node, 'body');
          if (body) {
            this.extractLocalVariables(body, context, symbols, funcSymbol);
          }
        }
        break;

      case 'declaration':
        // Handle function declarations, variable declarations, etc.
        this.extractDeclaration(node, context, symbols, parent);
        break;

      case 'field_declaration':
        const fieldSymbols = this.extractFieldDeclaration(node, context, parent);
        symbols.push(...fieldSymbols);
        break;

      case 'preproc_include':
        this.extractInclude(node, context, dependencies);
        break;

      case 'preproc_def':
        const macroSymbol = this.extractMacro(node, context, parent);
        if (macroSymbol) symbols.push(macroSymbol);
        break;
    }

    // Recursively process children
    for (const child of node.children) {
      // Skip nodes we already processed
      if (node.type === 'translation_unit') continue;
      if (node.type === 'namespace_definition' && child.type === 'declaration_list') continue;
      if (node.type === 'class_specifier' && child.type === 'field_declaration_list') continue;
      if (node.type === 'struct_specifier' && child.type === 'field_declaration_list') continue;
      if (node.type === 'union_specifier' && child.type === 'field_declaration_list') continue;
      if (node.type === 'function_definition' && child.type === 'compound_statement') continue;

      this.walkNode(child, context, symbols, dependencies, parent);
    }
  }

  private extractNamespace(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

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
      exported: true,
      language: this.getLanguage(),
    };
  }

  private extractClassOrStruct(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const kind = node.type === 'class_specifier' ? 'class' : 'interface';
    const keyword = node.type === 'class_specifier' ? 'class' : 'struct';

    // Check for inheritance
    const baseClauseNode = getChildForFieldName(node, 'base_class_clause');
    let signature = `${keyword} ${name}`;
    if (baseClauseNode) {
      signature += ` : ${getNodeText(baseClauseNode, context.content)}`;
    }

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
      exported: true,
      language: this.getLanguage(),
    };
  }

  private extractUnion(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    return {
      id,
      name,
      kind: 'type',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `union ${name}`,
      docstring,
      parent: parent?.id,
      children: [],
      exported: true,
      language: this.getLanguage(),
    };
  }

  private extractFunction(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const declaratorNode = getChildForFieldName(node, 'declarator');
    if (!declaratorNode) return null;

    // Extract function name from declarator
    const nameNode = this.findFunctionName(declaratorNode);
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    // Get return type
    const typeNode = getChildForFieldName(node, 'type');
    let signature = '';
    if (typeNode) {
      signature = `${getNodeText(typeNode, context.content)} `;
    }
    signature += getNodeText(declaratorNode, context.content);

    // Determine if it's a method
    const kind = context.currentClass ? 'method' : 'function';

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
      exported: true,
      language: this.getLanguage(),
    };
  }

  private extractDeclaration(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[], parent?: Symbol): void {
    const declarators = node.children.filter(child => child.type === 'declarator');
    const typeNode = getChildForFieldName(node, 'type');

    for (const declarator of declarators) {
      const nameNode = this.findDeclaratorName(declarator);
      if (!nameNode) continue;

      const name = getNodeText(nameNode, context.content);
      const id = `${context.filepath}:${name}:${node.startPosition.row}`;

      let signature = '';
      if (typeNode) {
        signature += `${getNodeText(typeNode, context.content)} `;
      }
      signature += getNodeText(declarator, context.content);

      // Determine if it's a function declaration
      if (this.isFunctionDeclarator(declarator)) {
        symbols.push({
          id,
          name,
          kind: context.currentClass ? 'method' : 'function',
          filepath: context.filepath,
          location: {
            start: { line: node.startPosition.row + 1, column: node.startPosition.column },
            end: { line: node.endPosition.row + 1, column: node.endPosition.column },
          },
          signature,
          docstring: undefined,
          parent: parent?.id,
          children: [],
          exported: true,
          language: this.getLanguage(),
        });
      } else {
        // Variable declaration
        symbols.push({
          id,
          name,
          kind: 'variable',
          filepath: context.filepath,
          location: {
            start: { line: node.startPosition.row + 1, column: node.startPosition.column },
            end: { line: node.endPosition.row + 1, column: node.endPosition.column },
          },
          signature,
          docstring: undefined,
          parent: parent?.id,
          children: [],
          exported: true,
          language: this.getLanguage(),
        });
      }
    }
  }

  private extractFieldDeclaration(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol[] {
    const symbols: Symbol[] = [];
    const typeNode = getChildForFieldName(node, 'type');
    const declarators = node.children.filter(child => child.type === 'field_declarator');

    for (const declarator of declarators) {
      const nameNode = getChildForFieldName(declarator, 'declarator');
      if (!nameNode) continue;

      const name = getNodeText(nameNode, context.content);
      const id = `${context.filepath}:${name}:${node.startPosition.row}`;

      let signature = name;
      if (typeNode) {
        signature = `${name}: ${getNodeText(typeNode, context.content)}`;
      }

      const bitfieldNode = getChildForFieldName(declarator, 'bitfield');
      if (bitfieldNode) {
        signature += `: ${getNodeText(bitfieldNode, context.content)}`;
      }

      symbols.push({
        id,
        name,
        kind: 'property',
        filepath: context.filepath,
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
        signature,
        docstring: undefined,
        parent: parent?.id,
        children: [],
        exported: true,
        language: this.getLanguage(),
      });
    }

    return symbols;
  }

  private extractMacro(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const valueNode = getChildForFieldName(node, 'value');
    let signature = `#define ${name}`;
    if (valueNode) {
      signature += ` ${getNodeText(valueNode, context.content)}`;
    }

    return {
      id,
      name,
      kind: 'constant',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring: undefined,
      parent: parent?.id,
      children: [],
      exported: true,
      language: this.getLanguage(),
    };
  }

  private extractInclude(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const pathNode = getChildForFieldName(node, 'path');
    if (pathNode) {
      const includePath = getNodeText(pathNode, context.content).replace(/[<>"]/g, '');
      context.includes.add(includePath);

      dependencies.push({
        from: context.filepath,
        to: includePath,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractLocalVariables(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[], parent: Symbol): void {
    if (node.type === 'compound_statement') {
      for (const child of node.children) {
        if (child.type === 'declaration') {
          this.extractDeclaration(child, context, symbols, parent);
        } else if (child.type === 'compound_statement') {
          this.extractLocalVariables(child, context, symbols, parent);
        }
      }
    }
  }

  private findFunctionName(declaratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    // Look for the function name in the declarator
    if (declaratorNode.type === 'identifier') {
      return declaratorNode;
    }

    for (const child of declaratorNode.children) {
      if (child.type === 'identifier') {
        return child;
      }
      if (child.type === 'function_declarator') {
        return this.findFunctionName(child);
      }
      if (child.type === 'pointer_declarator' || child.type === 'parameter_list') {
        continue; // Skip these, look for the identifier
      }
    }

    return null;
  }

  private findDeclaratorName(declaratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (declaratorNode.type === 'identifier') {
      return declaratorNode;
    }

    for (const child of declaratorNode.children) {
      if (child.type === 'identifier') {
        return child;
      }
      if (child.type !== 'pointer_declarator' && child.type !== 'array_declarator') {
        const result = this.findDeclaratorName(child);
        if (result) return result;
      }
    }

    return null;
  }

  private isFunctionDeclarator(declaratorNode: Parser.SyntaxNode): boolean {
    if (declaratorNode.type === 'function_declarator') {
      return true;
    }

    for (const child of declaratorNode.children) {
      if (child.type === 'function_declarator' || child.type === 'parameter_list') {
        return true;
      }
    }

    return false;
  }

  private extractComment(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for comments before this node
    const lines = content.split('\n');
    const startLine = node.startPosition.row;

    // Check previous lines for comments
    for (let i = startLine - 1; i >= 0; i--) {
      const line = lines[i].trim();

      // If we hit a non-comment line, stop searching
      if (line && !line.startsWith('/') && !line.startsWith('*')) {
        break;
      }

      // Check for comment format
      if (line.startsWith('/*') || line.startsWith('*') || line.startsWith('//')) {
        // Collect the full comment block
        const commentLines: string[] = [];
        for (let j = i; j >= 0 && j < lines.length; j++) {
          const currentLine = lines[j].trim();
          if (!currentLine.startsWith('/') && !currentLine.startsWith('*')) break;
          commentLines.push(currentLine);
        }

        // Clean up the comment and return it
        return commentLines
          .map(l => l.replace(/^\/[\*]*\s?/, '').replace(/\s*\*\/$/, '').replace(/^\*\s?/, ''))
          .filter(l => l || l === '')
          .join('\n');
      }
    }

    return undefined;
  }

  getSupportedExtensions(): string[] {
    return ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'];
  }

  getLanguage(): string {
    return this.isCppFile ? 'cpp' : 'c';
  }
}
