import Parser from 'tree-sitter';
import rustModule from 'tree-sitter-rust';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';
import { getChildForFieldName, getNodeText, findDescendantOfType, getChildrenOfType } from '../utils.js';

interface SymbolContext {
  filepath: string;
  content: string;
  imports: Set<string>;
  currentModule?: string;
  implBlock?: string; // Track which struct/enum we're implementing
}

export class RustParser extends BaseParser {
  private parser: Parser;
  private language: any;

  constructor() {
    super();
    this.parser = new Parser();
    this.language = rustModule;
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
    // Extract doc comments before this node
    const docstring = this.extractDocComments(node, context.content);

    switch (node.type) {
      case 'source_file':
        // Process all top-level items
        for (const child of node.children) {
          this.walkNode(child, context, symbols, dependencies);
        }
        break;

      case 'mod_item':
        const modSymbol = this.extractModule(node, context, docstring, parent);
        if (modSymbol) {
          symbols.push(modSymbol);
          context.currentModule = modSymbol.name;

          // Process module body
          for (const child of node.children) {
            if (child.type === 'declaration_list') {
              for (const decl of child.children) {
                this.walkNode(decl, context, symbols, dependencies, modSymbol);
              }
            }
          }
          context.currentModule = undefined;
        }
        break;

      case 'struct_item':
        const structSymbol = this.extractStruct(node, context, docstring, parent);
        if (structSymbol) {
          symbols.push(structSymbol);
          context.implBlock = structSymbol.name;

          // Process struct fields
          for (const child of node.children) {
            if (child.type === 'field_declaration_list') {
              for (const field of child.children) {
                if (field.type === 'field_declaration') {
                  const fieldSymbol = this.extractStructField(field, context, structSymbol);
                  if (fieldSymbol) symbols.push(fieldSymbol);
                }
              }
            }
          }
          context.implBlock = undefined;
        }
        break;

      case 'enum_item':
        const enumSymbol = this.extractEnum(node, context, docstring, parent);
        if (enumSymbol) {
          symbols.push(enumSymbol);
          context.implBlock = enumSymbol.name;

          // Process enum variants
          for (const child of node.children) {
            if (child.type === 'enum_variant_list') {
              for (const variant of child.children) {
                if (variant.type === 'enum_variant') {
                  const variantSymbol = this.extractEnumVariant(variant, context, enumSymbol);
                  if (variantSymbol) symbols.push(variantSymbol);
                }
              }
            }
          }
          context.implBlock = undefined;
        }
        break;

      case 'trait_item':
        const traitSymbol = this.extractTrait(node, context, docstring, parent);
        if (traitSymbol) {
          symbols.push(traitSymbol);
          context.implBlock = traitSymbol.name;

          // Process trait items
          for (const child of node.children) {
            if (child.type === 'declaration_list') {
              for (const decl of child.children) {
                if (decl.type === 'function_item' || decl.type === 'type_item') {
                  this.walkNode(decl, context, symbols, dependencies, traitSymbol);
                }
              }
            }
          }
          context.implBlock = undefined;
        }
        break;

      case 'impl_item':
        // Extract the type being implemented
        const typeNode = getChildForFieldName(node, 'type');
        if (typeNode) {
          const implType = getNodeText(typeNode, context.content);
          context.implBlock = implType;

          // Process impl body
          for (const child of node.children) {
            if (child.type === 'declaration_list') {
              for (const decl of child.children) {
                if (decl.type === 'function_item' || decl.type === 'constant_item') {
                  this.walkNode(decl, context, symbols, dependencies);
                }
              }
            }
          }
          context.implBlock = undefined;
        }
        break;

      case 'function_item':
        const funcSymbol = this.extractFunction(node, context, docstring, parent);
        if (funcSymbol) {
          symbols.push(funcSymbol);

          // Process function body for local variables
          const body = getChildForFieldName(node, 'body');
          if (body) {
            this.extractLocalVars(body, context, symbols, funcSymbol);
          }
        }
        break;

      case 'const_item':
        const constSymbol = this.extractConstant(node, context, docstring, parent);
        if (constSymbol) symbols.push(constSymbol);
        break;

      case 'static_item':
        const staticSymbol = this.extractStatic(node, context, docstring, parent);
        if (staticSymbol) symbols.push(staticSymbol);
        break;

      case 'type_item':
        const typeSymbol = this.extractTypeAlias(node, context, docstring, parent);
        if (typeSymbol) symbols.push(typeSymbol);
        break;

      case 'use_declaration':
        this.extractUseDeclaration(node, context, dependencies);
        break;
    }

    // Recursively process children
    for (const child of node.children) {
      // Skip nodes we already processed
      if (node.type === 'source_file') continue;
      if (node.type === 'mod_item' && child.type === 'declaration_list') continue;
      if (node.type === 'struct_item' && child.type === 'field_declaration_list') continue;
      if (node.type === 'enum_item' && child.type === 'enum_variant_list') continue;
      if (node.type === 'trait_item' && child.type === 'declaration_list') continue;
      if (node.type === 'impl_item' && child.type === 'declaration_list') continue;
      if (node.type === 'function_item' && child.type === 'block') continue;

      this.walkNode(child, context, symbols, dependencies, parent);
    }
  }

  private extractModule(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    return {
      id,
      name,
      kind: 'module',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `mod ${name}`,
      docstring,
      parent: parent?.id,
      children: [],
      // In Rust, pub modules are exported
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractStruct(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const genericParams = getChildForFieldName(node, 'generic_parameters');
    let signature = `struct ${name}`;
    if (genericParams) {
      signature += getNodeText(genericParams, context.content);
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
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractEnum(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const genericParams = getChildForFieldName(node, 'generic_parameters');
    let signature = `enum ${name}`;
    if (genericParams) {
      signature += getNodeText(genericParams, context.content);
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
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractTrait(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const genericParams = getChildForFieldName(node, 'generic_parameters');
    let signature = `trait ${name}`;
    if (genericParams) {
      signature += getNodeText(genericParams, context.content);
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
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractFunction(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const parametersNode = getChildForFieldName(node, 'parameters');
    const returnTypeNode = getChildForFieldName(node, 'return_type');
    const genericParams = getChildForFieldName(node, 'generic_parameters');

    let signature = `fn ${name}`;
    if (genericParams) {
      signature += getNodeText(genericParams, context.content);
    }
    signature += `(${(parametersNode ? getNodeText(parametersNode, context.content) : "") || ''})`;
    if (returnTypeNode) {
      signature += ` -> ${getNodeText(returnTypeNode, context.content)}`;
    }

    // Determine if it's a method (part of an impl block)
    const kind = context.implBlock ? 'method' : 'function';

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
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractConstant(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');
    const valueNode = getChildForFieldName(node, 'value');

    let signature = `const ${name}`;
    if (typeNode) {
      signature += `: ${getNodeText(typeNode, context.content)}`;
    }
    if (valueNode) {
      signature += ` = ${getNodeText(valueNode, context.content)}`;
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
      docstring,
      parent: parent?.id,
      children: [],
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractStatic(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');
    const valueNode = getChildForFieldName(node, 'value');

    let signature = `static ${name}`;
    if (typeNode) {
      signature += `: ${getNodeText(typeNode, context.content)}`;
    }
    if (valueNode) {
      signature += ` = ${getNodeText(valueNode, context.content)}`;
    }

    return {
      id,
      name,
      kind: 'variable',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractTypeAlias(node: Parser.SyntaxNode, context: SymbolContext, docstring?: string, parent?: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');
    const genericParams = getChildForFieldName(node, 'generic_parameters');

    let signature = `type ${name}`;
    if (genericParams) {
      signature += getNodeText(genericParams, context.content);
    }
    signature += ` = ${(typeNode ? getNodeText(typeNode, context.content) : "") || ''}`;

    return {
      id,
      name,
      kind: 'type',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature,
      docstring,
      parent: parent?.id,
      children: [],
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractStructField(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');

    let signature = name;
    if (typeNode) {
      signature += `: ${getNodeText(typeNode, context.content)}`;
    }

    return {
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
      parent: parent.id,
      children: [],
      exported: node.children.some(child => child.type === 'visibility_modifier' && getNodeText(child, context.content) === 'pub'),
      language: this.getLanguage(),
    };
  }

  private extractEnumVariant(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const nameNode = getChildForFieldName(node, 'name');
    if (!nameNode) return null;

    const name = getNodeText(nameNode, context.content);
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
      signature: getNodeText(node, context.content),
      docstring: undefined,
      parent: parent.id,
      children: [],
      exported: parent.exported, // Inherit from parent enum
      language: this.getLanguage(),
    };
  }

  private extractLocalVars(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[], parent: Symbol): void {
    if (node.type === 'block') {
      for (const child of node.children) {
        if (child.type === 'let_declaration') {
          const letSymbol = this.extractLocalVar(child, context, parent);
          if (letSymbol) symbols.push(letSymbol);
        } else if (child.type === 'block') {
          this.extractLocalVars(child, context, symbols, parent);
        }
      }
    }
  }

  private extractLocalVar(node: Parser.SyntaxNode, context: SymbolContext, parent: Symbol): Symbol | null {
    const patternNode = getChildForFieldName(node, 'pattern');
    if (!patternNode || patternNode.type !== 'identifier') return null;

    const name = getNodeText(patternNode, context.content);
    const id = `${context.filepath}:${name}:${node.startPosition.row}`;

    const typeNode = getChildForFieldName(node, 'type');
    const valueNode = getChildForFieldName(node, 'value');

    let signature = `let ${name}`;
    if (typeNode) {
      signature += `: ${getNodeText(typeNode, context.content)}`;
    }
    if (valueNode) {
      signature += ` = ${getNodeText(valueNode, context.content)}`;
    }

    return {
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
      parent: parent.id,
      children: [],
      exported: false, // Local variables are never exported
      language: this.getLanguage(),
    };
  }

  private extractUseDeclaration(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const argumentNode = getChildForFieldName(node, 'argument');
    if (argumentNode) {
      const usePath = getNodeText(argumentNode, context.content);
      context.imports.add(usePath);

      dependencies.push({
        from: context.filepath,
        to: usePath,
        type: 'imports',
        location: {
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        },
      });
    }
  }

  private extractDocComments(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for doc comments (/// or /** ... */) before this node
    const lines = content.split('\n');
    const startLine = node.startPosition.row;

    const docLines: string[] = [];

    // Check previous lines for doc comments
    for (let i = startLine - 1; i >= 0; i--) {
      const line = lines[i].trim();

      // If we hit a non-comment line, stop searching
      if (line && !line.startsWith('//') && !line.startsWith('/*')) {
        break;
      }

      // Check for doc comment format
      if (line.startsWith('///')) {
        docLines.unshift(line.substring(3).trim());
      } else if (line.startsWith('/**') && line.endsWith('*/')) {
        // Multi-line doc comment
        let comment = line.substring(3, line.length - 2).trim();
        docLines.unshift(comment);
        break;
      }
    }

    return docLines.length > 0 ? docLines.join('\n') : undefined;
  }

  getSupportedExtensions(): string[] {
    return ['.rs'];
  }

  getLanguage(): string {
    return 'rust';
  }
}