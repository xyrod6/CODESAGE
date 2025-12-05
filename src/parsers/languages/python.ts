import Parser from 'tree-sitter';
import python from 'tree-sitter-python';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';

interface SymbolContext {
  filepath: string;
  content: string;
  imports: Set<string>;
  currentClass?: string;
  currentModule?: string;
}

export class PythonParser extends BaseParser {
  private parser: Parser;
  private language: any;

  constructor() {
    super();
    this.parser = new Parser();
    this.language = python;
    this.parser.setLanguage(this.language);
  }

  async parse(filepath: string, content: string): Promise<ParseResult> {
    const tree = this.parser.parse(content);
    const symbols: Symbol[] = [];
    const dependencies: DependencyEdge[] = [];

    const context: SymbolContext = {
      filepath,
      content,
      imports: new Set(),
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
    // Extract docstring before this node
    const docstring = this.extractDocstring(node, context.content);

    switch (node.type) {
      case 'class_definition':
        const classSymbol = this.extractClass(node, context, docstring, parent);
        if (classSymbol) {
          symbols.push(classSymbol);
          context.currentClass = classSymbol.name;

          // Process class body
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.children) {
              this.walkNode(child, context, symbols, dependencies, classSymbol);
            }
          }
          context.currentClass = undefined;
        }
        break;

      case 'function_definition':
        const funcSymbol = this.extractFunction(node, context, docstring, parent);
        if (funcSymbol) {
          symbols.push(funcSymbol);

          // Process function body
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.children) {
              this.walkNode(child, context, symbols, dependencies, funcSymbol);
            }
          }
        }
        break;

      case 'assignment':
        // Handle class variables and module-level variables
        if (node.childCount > 1) {
          const left = node.child(0);
          const right = node.child(2); // Skip the '='

          if (left.type === 'identifier' && (!context.currentClass || right?.text.includes('self.'))) {
            const varSymbol = this.extractVariable(node, context, parent);
            if (varSymbol) symbols.push(varSymbol);
          }
        }
        break;

      case 'import_statement':
        this.extractImport(node, context, dependencies);
        break;

      case 'import_from_statement':
        this.extractFromImport(node, context, dependencies);
        break;

      case 'decorated_definition':
        // Process the actual definition under the decorator
        for (const child of node.children) {
          if (child.type !== 'decorator' && child.type !== 'comment') {
            this.walkNode(child, context, symbols, dependencies, parent);
          }
        }
        break;
    }

    // Recursively process children
    for (const child of node.children) {
      // Skip nodes we already processed
      if (node.type === 'class_definition' && child.type === 'block') continue;
      if (node.type === 'function_definition' && child.type === 'block') continue;
      if (node.type === 'decorated_definition' &&
          (child.type === 'decorator' || child.type === 'function_definition' || child.type === 'class_definition')) continue;

      this.walkNode(child, context, symbols, dependencies, parent);
    }
  }

  private extractClass(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    // Check for inheritance
    const superClassList = node.childForFieldName('superclasses');
    let signature = `class ${name}`;
    if (superClassList) {
      signature += superClassList.text;
    }

    return {
      id,
      name,
      kind: 'class',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      exported: true, // In Python, most classes are "exported" by default
      language: this.getLanguage(),
    };
  }

  private extractFunction(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const parametersNode = node.childForFieldName('parameters');
    const returnTypeNode = node.childForFieldName('return_type');

    let signature = `def ${name}(${parametersNode?.text || ''})`;
    if (returnTypeNode) {
      signature += ` -> ${returnTypeNode.text}`;
    }

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
      exported: true, // In Python, most functions are "exported" by default
      language: this.getLanguage(),
    };
  }

  private extractVariable(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol | null {
    const left = node.child(0);
    if (!left || left.type !== 'identifier') return null;

    const name = left.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    // Determine if it's a constant (ALL_CAPS)
    const isConstant = name === name.toUpperCase() && name.includes('_');

    return {
      id,
      name,
      kind: isConstant ? 'constant' : 'variable',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: node.text,
      docstring: undefined,
      parent: parent?.id,
      children: [],
      exported: true,
      language: this.getLanguage(),
    };
  }

  private extractImport(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const moduleName = nameNode.text;
      context.imports.add(moduleName);

      dependencies.push({
        from: context.filepath,
        to: moduleName,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractFromImport(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const moduleNameNode = node.childForFieldName('module_name');
    if (moduleNameNode) {
      const moduleName = moduleNameNode.text;
      context.imports.add(moduleName);

      dependencies.push({
        from: context.filepath,
        to: moduleName,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractDocstring(node: Parser.SyntaxNode, content: string): string | undefined {
    // Check if the first child of a function/class body is a docstring
    const body = node.childForFieldName('body');
    if (!body) return undefined;

    // Look for the first expression statement that contains a string
    for (const child of body.children) {
      if (child.type === 'expression_statement') {
        const stringNode = child.childForFieldName('value');
        if (stringNode && (stringNode.type === 'string' || stringNode.type === 'concatenated_string')) {
          // Extract the docstring content
          const text = stringNode.text;
          // Remove surrounding quotes and escape sequences
          let docstring = text.replace(/^['"]{1,3}|['"]{1,3}$/g, '');

          // Clean up indentation and common docstring formatting
          const lines = docstring.split('\n');
          const cleanedLines = lines.map(line => {
            // Remove common indentation
            const trimmed = line.replace(/^\s*/, '');
            // Remove docstring markers like spaces after quotes
            return trimmed.replace(/^\s+/, '');
          });

          return cleanedLines.join('\n').trim();
        }
      }
      // Stop looking after we hit something other than a simple statement or comment
      if (child.type !== 'expression_statement' && child.type !== 'comment') {
        break;
      }
    }

    return undefined;
  }

  getSupportedExtensions(): string[] {
    return ['.py'];
  }

  getLanguage(): string {
    return 'python';
  }
}