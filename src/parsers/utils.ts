import { SyntaxNode } from 'tree-sitter';

/**
 * Utility functions for tree-sitter nodes to handle API compatibility
 */

/**
 * Get child node for field name with fallback compatibility
 */
export function getChildForFieldName(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  // Try the newer API first
  if ('childForFieldName' in node) {
    return (node as any).childForFieldName(fieldName);
  }

  // Fallback for older tree-sitter versions
  const children = (node as any).children || [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Check if child has fieldName property
    if (child && (child as any).fieldName === fieldName) {
      return child;
    }
  }

  return null;
}

/**
 * Get node text safely
 */
export function getNodeText(node: SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

/**
 * Check if node is of specific type
 */
export function isNodeType(node: SyntaxNode, type: string): boolean {
  return node.type === type;
}

/**
 * Find first descendant of type
 */
export function findDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  // For older tree-sitter versions, use a simple traversal
  const stack: SyntaxNode[] = [node];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === type) {
      return current;
    }

    // Add children to stack
    for (let i = current.children.length - 1; i >= 0; i--) {
      stack.push(current.children[i]);
    }
  }

  return null;
}

/**
 * Get all children of type
 */
export function getChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.children.filter(child => child.type === type);
}

/**
 * Safely navigate node tree
 */
export function safeNavigate(node: SyntaxNode | null, ...path: string[]): SyntaxNode | null {
  let current = node;
  for (const step of path) {
    if (!current) return null;
    current = getChildForFieldName(current, step);
  }
  return current;
}