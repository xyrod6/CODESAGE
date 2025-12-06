// Type declarations for tree-sitter language modules
declare module 'tree-sitter-go' {
  const go: any;
  export default go;
}

declare module 'tree-sitter-typescript' {
  const typescript: any;
  const tsx: any;
  export default typescript;
  export { tsx };
}

declare module 'tree-sitter-rust' {
  const rust: any;
  export default rust;
}