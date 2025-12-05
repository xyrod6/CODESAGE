import Parser from 'tree-sitter';
import java from 'tree-sitter-java';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';

interface SymbolContext {
  filepath: string;
  content: string;
  imports: Set<string>;
  currentPackage?: string;
  currentClass?: string;
}

export class JavaParser extends BaseParser {
  private parser: Parser;
  private language: any;

  constructor() {
    super();
    this.parser = new Parser();
    this.language = java;
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
    // Extract Javadoc before this node
    const docstring = this.extractJavadoc(node, context.content);

    switch (node.type) {
      case 'program':
        // Extract package declaration
        for (const child of node.children) {
          if (child.type === 'package_declaration') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
              context.currentPackage = nameNode.text;
            }
          }
          // Process other top-level declarations
          this.walkNode(child, context, symbols, dependencies, parent);
        }
        break;

      case 'class_declaration':
        const classSymbol = this.extractClass(node, context, docstring, parent);
        if (classSymbol) {
          symbols.push(classSymbol);
          context.currentClass = classSymbol.name;

          // Process class body
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'field_declaration' ||
                  child.type === 'method_declaration' ||
                  child.type === 'constructor_declaration') {
                this.walkNode(child, context, symbols, dependencies, classSymbol);
              }
            }
          }
          context.currentClass = undefined;
        }
        break;

      case 'interface_declaration':
        const interfaceSymbol = this.extractInterface(node, context, docstring, parent);
        if (interfaceSymbol) {
          symbols.push(interfaceSymbol);
          context.currentClass = interfaceSymbol.name;

          // Process interface body
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'field_declaration' ||
                  child.type === 'method_declaration') {
                this.walkNode(child, context, symbols, dependencies, interfaceSymbol);
              }
            }
          }
          context.currentClass = undefined;
        }
        break;

      case 'enum_declaration':
        const enumSymbol = this.extractEnum(node, context, docstring, parent);
        if (enumSymbol) {
          symbols.push(enumSymbol);

          // Process enum body
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.children) {
              if (child.type === 'enum_constant') {
                const constSymbol = this.extractEnumConstant(child, context, enumSymbol);
                if (constSymbol) symbols.push(constSymbol);
              }
            }
          }
        }
        break;

      case 'method_declaration':
        const methodSymbol = this.extractMethod(node, context, docstring, parent);
        if (methodSymbol) {
          symbols.push(methodSymbol);

          // Process method body for local variables
          const body = node.childForFieldName('body');
          if (body) {
            this.extractLocalVariables(body, context, symbols, methodSymbol);
          }
        }
        break;

      case 'constructor_declaration':
        const constructorSymbol = this.extractConstructor(node, context, docstring, parent);
        if (constructorSymbol) {
          symbols.push(constructorSymbol);

          // Process constructor body
          const body = node.childForFieldName('body');
          if (body) {
            this.extractLocalVariables(body, context, symbols, constructorSymbol);
          }
        }
        break;

      case 'field_declaration':
        const fieldSymbols = this.extractFieldDeclaration(node, context, parent);
        symbols.push(...fieldSymbols);
        break;

      case 'import_declaration':
        this.extractImport(node, context, dependencies);
        break;
    }

    // Recursively process children
    for (const child of node.children) {
      // Skip nodes we already processed
      if (node.type === 'program') continue;
      if (node.type === 'class_declaration' && child.type === 'class_body') continue;
      if (node.type === 'interface_declaration' && child.type === 'interface_body') continue;
      if (node.type === 'enum_declaration' && child.type === 'enum_body') continue;
      if (node.type === 'method_declaration' && child.type === 'block') continue;
      if (node.type === 'constructor_declaration' && child.type === 'block') continue;

      this.walkNode(child, context, symbols, dependencies, parent);
    }
  }

  private extractClass(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    // Check for inheritance and interfaces
    const superClass = node.childForFieldName('superclass');
    const interfaces = node.childForFieldName('interfaces');

    let signature = `class ${name}`;
    if (superClass) {
      signature += ` extends ${superClass.text}`;
    }
    if (interfaces) {
      signature += ` implements ${interfaces.text}`;
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
      exported: true, // In Java, public classes are exported
      language: this.getLanguage(),
    };
  }

  private extractInterface(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const interfaces = node.childForFieldName('interfaces');

    let signature = `interface ${name}`;
    if (interfaces) {
      signature += ` extends ${interfaces.text}`;
    }

    return {
      id,
      name,
      kind: 'interface',
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

  private extractEnum(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const interfaces = node.childForFieldName('interfaces');

    let signature = `enum ${name}`;
    if (interfaces) {
      signature += ` implements ${interfaces.text}`;
    }

    return {
      id,
      name,
      kind: 'enum',
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

  private extractMethod(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const parametersNode = node.childForFieldName('parameters');
    const typeNode = node.childForFieldName('type');
    const modifiers = node.childForFieldName('modifiers');

    let signature = name;
    if (parametersNode) {
      signature += `(${parametersNode.text})`;
    }
    if (typeNode) {
      signature += `: ${typeNode.text}`;
    }

    // Check if it's public
    const isPublic = modifiers ? this.hasPublicModifier(modifiers) : true;

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
      exported: isPublic,
      language: this.getLanguage(),
    };
  }

  private extractConstructor(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const parametersNode = node.childForFieldName('parameters');
    const modifiers = node.childForFieldName('modifiers');

    let signature = name;
    if (parametersNode) {
      signature += `(${parametersNode.text})`;
    }

    const isPublic = modifiers ? this.hasPublicModifier(modifiers) : true;

    return {
      id,
      name,
      kind: 'constructor',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      exported: isPublic,
      language: this.getLanguage(),
    };
  }

  private extractFieldDeclaration(node: Parser.SyntaxNode, context: SymbolContext, parent?: Symbol): Symbol[] {
    const symbols: Symbol[] = [];
    const typeNode = node.childForFieldName('type');
    const modifiers = node.childForFieldName('modifiers');
    const declaratorList = node.childForFieldName('declarator');

    const isPublic = modifiers ? this.hasPublicModifier(modifiers) : false;
    const isStatic = modifiers ? this.hasStaticModifier(modifiers) : false;

    if (declaratorList) {
      for (const child of declaratorList.children) {
        if (child.type === 'variable_declarator') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const name = nameNode.text;
            const id = `${context.filepath}:${name}:${node.startPosition.row}`;

            let signature = name;
            if (typeNode) {
              signature += `: ${typeNode.text}`;
            }

            const valueNode = child.childForFieldName('value');
            if (valueNode) {
              signature += ` = ${valueNode.text}`;
            }

            symbols.push({
              id,
              name,
              kind: isStatic ? 'constant' : 'property',
              filepath: context.filepath,
              location: {
                start: { line: node.startPosition.row + 1, column: node.startPosition.column },
                end: { line: node.endPosition.row + 1, column: node.endPosition.column },
              },
              signature,
              docstring: undefined,
              parent: parent?.id,
              children: [],
              exported: isPublic,
              language: this.getLanguage(),
            });
          }
        }
      }
    }

    return symbols;
  }

  private extractEnumConstant(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
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

  private extractLocalVariables(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[], parent: Symbol): void {
    for (const child of node.children) {
      if (child.type === 'local_variable_declaration') {
        const typeNode = child.childForFieldName('type');
        const declaratorList = child.childForFieldName('declarator');

        if (declaratorList) {
          for (const declarator of declaratorList.children) {
            if (declarator.type === 'variable_declarator') {
              const nameNode = declarator.childForFieldName('name');
              if (nameNode) {
                const name = nameNode.text;
                const id = `${context.filepath}:${name}:${child.startPosition.row}`;

                let signature = name;
                if (typeNode) {
                  signature += `: ${typeNode.text}`;
                }

                const valueNode = declarator.childForFieldName('value');
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
                  parent: parent.id,
                  children: [],
                  exported: false,
                  language: this.getLanguage(),
                });
              }
            }
          }
        }
      } else if (child.type === 'block') {
        this.extractLocalVariables(child, context, symbols, parent);
      }
    }
  }

  private extractImport(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const importPath = nameNode.text;
      context.imports.add(importPath);

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

  private hasPublicModifier(modifiersNode: Parser.SyntaxNode): boolean {
    for (const child of modifiersNode.children) {
      if (child.type === 'modifiers' || child.type === 'modifier') {
        for (const modifier of child.children) {
          if (modifier.text === 'public') {
            return true;
          }
        }
      }
    }
    return false;
  }

  private hasStaticModifier(modifiersNode: Parser.SyntaxNode): boolean {
    for (const child of modifiersNode.children) {
      if (child.type === 'modifiers' || child.type === 'modifier') {
        for (const modifier of child.children) {
          if (modifier.text === 'static') {
            return true;
          }
        }
      }
    }
    return false;
  }

  private extractJavadoc(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for Javadoc comments before this node
    const lines = content.split('\n');
    const startLine = node.startPosition.row;

    // Check previous lines for Javadoc
    for (let i = startLine - 1; i >= 0; i--) {
      const line = lines[i].trim();

      // If we hit a non-comment line, stop searching
      if (line && !line.startsWith('/*') && !line.startsWith('*') && !line.startsWith('//')) {
        break;
      }

      // Check for Javadoc format
      if (line.startsWith('/**')) {
        // Collect the full Javadoc comment
        const javadocLines: string[] = [];
        for (let j = i; j < lines.length; j++) {
          const currentLine = lines[j].trim();
          javadocLines.push(currentLine);

          if (currentLine.endsWith('*/')) {
            break;
          }
        }

        // Clean up the Javadoc and return it
        return javadocLines
          .map(l => l.replace(/^\/?\*+\s?/, '').replace(/\s*\*\/$/, ''))
          .filter(l => l || l === '')
          .join('\n');
      }
    }

    return undefined;
  }

  getSupportedExtensions(): string[] {
    return ['.java'];
  }

  getLanguage(): string {
    return 'java';
  }
}