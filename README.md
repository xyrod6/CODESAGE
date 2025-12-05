# CODESAGE

**Code Ontology Discovery & Exploration System**

> Your companion for understanding codebases. CODESAGE provides persistent knowledge about your code, enabling smarter development with Claude Code.

## ✨ Features

- **🔍 Symbol Discovery** - Find classes, functions, and variables across your codebase
- **📊 Dependency Analysis** - Understand what depends on what before making changes
- **⚡ Impact Assessment** - See what might break when you modify files
- **🎯 Smart Prioritization** - Identifies important code using PageRank algorithm
- **🔄 Real-time Updates** - File watching keeps knowledge up-to-date
- **🌐 Multi-language Support** - Full parsing for TypeScript, JavaScript, Python, Go, Rust, Java, C/C++

## 🚀 Quick Start

### 1. Install

```bash
npm install -g codesage
```

### 2. Start Redis

```bash
# macOS
brew services start redis

# Ubuntu/Debian
sudo systemctl start redis-server

# Docker
docker run -d -p 6379:6379 redis
```

### 3. Use with Claude Code

Restart Claude Code, then simply say:

> "Please index the current project using codesage"

## 💬 Example Conversations

### Search & Discovery
```
You: Find all classes related to storage
CODESAGE: Found 3 classes:
  - Storage (src/storage/index.ts)
  - RedisStorage (src/storage/redis.ts)
  - GraphTraversal (src/graph/traversal.ts)
```

### Dependency Analysis
```
You: What depends on RedisStorage?
CODESAGE: The following files depend on RedisStorage:
  - src/server.ts (imports Storage)
  - src/indexer/index.ts (uses storage.getAllSymbols)
  - 2 other files
```

### Project Overview
```
You: Show me the project structure
CODESAGE: Found 35 TypeScript files with 6,173 lines of code
  Top symbols by importance:
    - PageRankCalculator (src/graph/pagerank.ts)
    - SymbolExtractor (src/indexer/symbol-extractor.ts)
    - RedisStorage (src/storage/redis.ts)
```

## 🛠️ Available Tools

### Core Operations
- `index_project` - Build knowledge of your codebase
- `search_symbols` - Find symbols by name or pattern
- `get_symbol` - Get detailed symbol information
- `get_file_structure` - View all symbols in a file
- `get_project_overview` - See the big picture

### Analysis Tools
- `get_dependencies` - What a symbol/file depends on
- `get_dependents` - What depends on a symbol/file
- `get_impact` - Analyze potential breaking changes
- `find_similar` - Find similar code patterns
- `get_symbol_history` - Track code stability

## 📁 What CODESAGE Analyzes

- **Functions & Methods** - Signatures, parameters, types
- **Classes & Interfaces** - Properties, methods, inheritance
- **Variables & Constants** - Types, scopes
- **Imports & Exports** - Module dependencies
- **Type Definitions** - Custom types, enums

## ⚙️ Configuration

Create `codesage.config.json` in your project:

```json
{
  "redis": {
    "url": "redis://localhost:6379",
    "keyPrefix": "codesage:"
  },
  "indexer": {
    "include": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.py", "**/*.go", "**/*.rs", "**/*.java", "**/*.c", "**/*.cpp"],
    "exclude": ["**/node_modules/**", "**/dist/**", "**/target/**", "**/build/**"],
    "maxFileSize": 1048576
  },
  "watcher": {
    "enabled": true,
    "debounceMs": 1000
  }
}
```

## 🔧 Implementation

CODESAGE is built with:

- **Tree-sitter parsers** for accurate code understanding
- **Redis storage** for fast symbol lookup
- **PageRank algorithm** for importance scoring
- **MCP protocol** for Claude Code integration
- **File watching** with chokidar for real-time updates

## 📊 What's Inside

### Language Support
- **TypeScript/JavaScript** - Classes, interfaces, functions, types, JSDoc
- **Python** - Classes, functions, methods, docstrings, imports
- **Go** - Structs, interfaces, functions, methods, godoc comments
- **Rust** - Structs, enums, traits, impl blocks, doc comments
- **Java** - Classes, interfaces, enums, methods, Javadoc
- **C/C++** - Classes, structs, functions, namespaces, macros

### Core Components
- **11 MCP tools** for code analysis
- **Redis storage layer** with connection pooling
- **Dependency resolver** for mapping relationships
- **Symbol extractors** using tree-sitter for each language
- **Git metadata tracking** for stability metrics

## 🎯 Real Capabilities

- ✅ **Full parsing** for TypeScript, JavaScript, Python, Go, Rust, Java, C/C++
- ✅ **Builds dependency graphs** between all symbols across languages
- ✅ **Calculates PageRank scores** to identify important code
- ✅ **Tracks file changes** and updates incrementally
- ✅ **Integrates with Claude Code** via MCP
- ✅ **Stores all data in Redis** for fast retrieval

## Language-Specific Features

### TypeScript/JavaScript
- Class inheritance and interface implementation
- JSDoc extraction
- Import/export analysis
- Type aliases and enums

### Python
- Docstring extraction (""" and ''')
- Decorator support
- Class method detection
- Import/from-import tracking

### Go
- Struct embedding
- Interface implementation
- Godoc comment parsing
- Package-level visibility

### Rust
- Trait implementations
- Lifetime annotations
- Macro expansion support
- Module visibility

### Java
- Annotation support
- Generic type parameters
- Access modifier detection
- Package imports

### C/C++
- Template support (C++)
- Namespace handling
- Preprocessor macros
- Header file dependencies

## Limitations

- Requires Redis server to be running
- Performance depends on codebase size and Redis configuration
- Some advanced language features may not be fully supported

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/xyrod6/CODESAGE/issues)
- **Documentation**: [User Guide](./USER_GUIDE.md)

---

**CODESAGE** - Transform how you understand code. 🧙‍♂️✨