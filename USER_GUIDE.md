# CODESAGE User Guide

## Getting Started with CODESAGE

CODESAGE (Code Ontology Discovery & Exploration System) is a powerful code analysis tool that integrates with Claude Code through the Model Context Protocol (MCP). It provides persistent knowledge about your codebase, enabling faster and more accurate development assistance.

## Installation

### Quick Install

```bash
npm install -g codesage
```

The installer will automatically:
1. Configure Claude Code to use CODESAGE
2. Create a default configuration file
3. Check for Redis dependencies

### Manual Installation

If the automatic installation doesn't work, you can manually configure CODESAGE:

1. Install CODESAGE:
   ```bash
   npm install -g codesage
   ```

2. Add to `~/.claude.json`:
   ```json
   {
     "mcpServers": {
       "codesage": {
         "command": "node",
         "args": ["[PATH_TO_CODESAGE]/dist/index.js"],
         "env": {
           "CODESAGE_CONFIG": "[PATH_TO_CONFIG]/codesage.config.json"
         }
       }
     }
   }
   ```

3. Create `~/.codesage.config.json` with default settings.

### Prerequisites

- **Node.js 18+** - Required for CODESAGE to run
- **Redis server** - Required for storing code analysis data

#### Installing Redis

**macOS:**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt-get install redis-server
sudo systemctl start redis-server
```

**Windows:**
```bash
# Using WSL
wsl --install
sudo apt-get install redis-server
sudo systemctl start redis-server

# Or using Docker
docker run -d -p 6379:6379 redis
```

## First Use

1. **Restart Claude Code** after installation
2. **Index your project:**
   ```
   Please index the current project using codesage
   ```
3. **Start exploring!**

## Common Commands

### Project Analysis

- "Index the current project"
- "Show me the project overview"
- "What are the most important files in this project?"

### Symbol Search

- "Find all functions related to authentication"
- "Search for classes ending with 'Controller'"
- "Where is the UserService defined?"

### Dependency Analysis

- "What depends on AuthService.ts?"
- "What will break if I modify config.js?"
- "Show me the dependencies of api/routes.js"

### Code Discovery

- "Find similar code to this authentication middleware"
- "Show me all API endpoints"
- "Where are database queries handled?"

## Configuration

Your CODESAGE configuration is stored in `~/.codesage.config.json`. You can customize:

### File Filtering

```json
{
  "indexer": {
    "include": [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx"
    ],
    "exclude": [
      "**/node_modules/**",
      "**/test/**",
      "**/*.spec.ts"
    ]
  }
}
```

### Performance Tuning

```json
{
  "indexer": {
    "maxFileSize": 2097152,
    "parallelJobs": 4
  },
  "watcher": {
    "enabled": true,
    "debounceMs": 500
  }
}
```

### Redis Settings

```json
{
  "redis": {
    "url": "redis://localhost:6379",
    "keyPrefix": "myproject:",
    "maxRetries": 3
  }
}
```

## Project-Specific Config

To use project-specific settings, create `codesage.config.json` in your project root. CODESAGE will use this file instead of the global config.

## Troubleshooting

### Common Issues

**"Redis connection failed"**
- Ensure Redis is running: `redis-cli ping`
- Check Redis configuration in your config file

**"No symbols found"**
- Verify your file patterns match your code
- Check that files aren't excluded by the patterns
- Run indexing again

**"Slow performance"**
- Increase Redis memory if needed
- Adjust `maxFileSize` to exclude large files
- Disable file watching if not needed: `"watcher": {"enabled": false}`

### Debug Mode

Enable debug logging by setting the environment variable:
```bash
export CODESAGE_DEBUG=true
```

### Resetting Index

To clear all indexed data and start fresh:
```bash
redis-cli
> FLUSHALL CODESAGE:*
```

Or to clear all data:
```bash
redis-cli flushdb
```

Then re-index your project.

## Best Practices

1. **Index First**: Always index your project before asking questions
2. **Be Specific**: Use precise search terms for better results
3. **Check Dependencies**: Use impact analysis before making changes
4. **Regular Updates**: Re-index after major changes
5. **Project Config**: Use project-specific configs for different setups

## Tips & Tricks

### Finding Entry Points
```
Show me the main entry points and exported symbols
```

### Understanding Architecture
```
What are the core modules and how do they connect?
```

### Refactoring Safely
```
What tests will be affected by changing the User model?
```

### Learning Codebases
```
Explain the overall architecture and key patterns
```

## Examples

### Authentication System
```
Find all authentication-related code including:
- Login/logout functions
- Auth middleware
- User validation
- Session management
```

### API Routes
```
Show all API endpoints with their:
- HTTP methods
- Request/response models
- Authentication requirements
```

### Database Layer
```
Find database operations:
- All queries
- Database connections
- Migration files
- ORM models
```

## Getting Help

- **Documentation**: Check the README.md in the project
- **Issues**: Report bugs on GitHub
- **Contributing**: See CONTRIBUTING.md
- **Community**: Join discussions in GitHub Discussions

## Performance Tips

1. **Large Projects**: Exclude build artifacts and dependencies
2. **Frequent Changes**: Disable file watching for better performance
3. **Memory Usage**: Adjust `maxFileSize` to limit large file indexing
4. **Network Redis**: Use a local Redis instance for best performance

## Security Note

CODESAGE indexes code locally and stores analysis data in your Redis instance. No code is sent to external servers. Ensure your Redis instance is properly secured if running in a shared environment.