import Parser from 'tree-sitter';
import htmlModule from 'tree-sitter-html';
import { Parser as BaseParser, ParseResult, Symbol, DependencyEdge, SymbolKind } from '../base.js';
import { getNodeText } from '../utils.js';

interface SymbolContext {
  filepath: string;
  content: string;
  dependencies: Set<string>;
}

export class HTMLParser extends BaseParser {
  private parser: Parser;
  private language: any;

  constructor() {
    super();
    this.parser = new Parser();
    this.language = htmlModule;
    this.parser.setLanguage(this.language);
  }

  async parse(filepath: string, content: string): Promise<ParseResult> {
    const tree = this.parser.parse(content);
    const symbols: Symbol[] = [];
    const dependencies: DependencyEdge[] = [];

    const context: SymbolContext = {
      filepath,
      content,
      dependencies: new Set(),
    };

    // Walk the tree to extract symbols
    this.walkNode(tree.rootNode, context, symbols, dependencies);

    return {
      symbols,
      dependencies,
      language: this.getLanguage(),
    };
  }

  private walkNode(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[], dependencies: DependencyEdge[]): void {
    switch (node.type) {
      case 'script_element':
      case 'style_element':
        this.extractEmbeddedElement(node, context, symbols);
        break;

      case 'element':
        this.extractElement(node, context, symbols);
        break;

      case 'attribute':
        this.extractAttributeDependency(node, context, dependencies);
        break;
    }

    // Recursively process children
    for (const child of node.children) {
      this.walkNode(child, context, symbols, dependencies);
    }
  }

  private extractEmbeddedElement(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[]): void {
    const tagNameNode = node.childForFieldName('tag');
    if (!tagNameNode) return;

    const tagName = getNodeText(tagNameNode, context.content);
    const id = `${context.filepath}:${tagName}:${node.startPosition.row}`;

    // Get the content between script/style tags
    const startTagNode = node.childForFieldName('start_tag');
    const endTagNode = node.childForFieldName('end_tag');

    let content = '';
    if (startTagNode && endTagNode) {
      const startIndex = startTagNode.endIndex;
      const endIndex = endTagNode.startIndex;
      content = context.content.substring(startIndex, endIndex).trim();
    }

    const kind = tagName === 'script' ? 'script' : 'style';

    symbols.push({
      id,
      name: tagName,
      kind: kind as SymbolKind,
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `<${tagName}>${content ? '...' : ''}</${tagName}>`,
      docstring: undefined,
      parent: undefined,
      children: [],
      exported: true,
      language: this.getLanguage(),
    });
  }

  private extractElement(node: Parser.SyntaxNode, context: SymbolContext, symbols: Symbol[]): void {
    const tagNameNode = node.childForFieldName('tag');
    if (!tagNameNode) return;

    const tagName = getNodeText(tagNameNode, context.content);

    // Focus on important elements
    const importantTags = ['header', 'footer', 'nav', 'main', 'section', 'article', 'aside', 'div', 'form'];
    if (!importantTags.includes(tagName.toLowerCase())) return;

    const idNode = node.child(0)?.childForFieldName('attribute')?.children.find(child =>
      child.childForFieldName('name')?.text === 'id'
    );

    let name = tagName;
    if (idNode) {
      const valueNode = idNode.childForFieldName('value');
      if (valueNode) {
        const idValue = getNodeText(valueNode, context.content).replace(/['"]/g, '');
        name = `${tagName}#${idValue}`;
      }
    }

    const elementId = `${context.filepath}:${name}:${node.startPosition.row}`;

    symbols.push({
      id: elementId,
      name,
      kind: 'element',
      filepath: context.filepath,
      location: {
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      },
      signature: `<${tagName}>`,
      docstring: undefined,
      parent: undefined,
      children: [],
      exported: true,
      language: this.getLanguage(),
    });
  }

  private extractAttributeDependency(node: Parser.SyntaxNode, context: SymbolContext, dependencies: DependencyEdge[]): void {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');

    if (!nameNode || !valueNode) return;

    const attrName = getNodeText(nameNode, context.content);
    const attrValue = getNodeText(valueNode, context.content).replace(/['"]/g, '');

    // Extract external dependencies from attributes
    if (attrName === 'src' || attrName === 'href') {
      if (attrValue.startsWith('http') || attrValue.startsWith('//')) {
        dependencies.push({
          from: context.filepath,
          to: attrValue,
          type: 'references',
          location: {
            start: { line: node.startPosition.row + 1, column: node.startPosition.column },
            end: { line: node.endPosition.row + 1, column: node.endPosition.column },
          },
        });
      } else if (attrValue.startsWith('./') || attrValue.startsWith('../')) {
        // Local file reference
        const url = new URL(attrValue, `file://${context.filepath}`);
        dependencies.push({
          from: context.filepath,
          to: url.pathname,
          type: 'references',
          location: {
            start: { line: node.startPosition.row + 1, column: node.startPosition.column },
            end: { line: node.endPosition.row + 1, column: node.endPosition.column },
          },
        });
      }
    }
  }

  getSupportedExtensions(): string[] {
    return ['.html', '.htm'];
  }

  getLanguage(): string {
    return 'html';
  }
}