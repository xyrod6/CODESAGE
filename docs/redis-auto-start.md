# Redis Auto-Start Feature

AGImake includes an automatic Redis startup feature that helps ensure Redis is available when the application starts. This feature provides a seamless experience by automatically starting Redis if it's not already running.

## How it Works

When AGImake initializes its storage layer, it performs the following steps:

1. **Check if Redis is running**: The system attempts to detect if Redis is already accessible at the configured URL.
2. **Auto-start if needed**: If Redis is not running, the system attempts to start it automatically.
3. **Wait for readiness**: The system waits for Redis to be ready to accept connections.
4. **Proceed with connection**: Once Redis is ready, AGImake connects and continues normal operation.

## Platform Support

### macOS
- Searches for Redis in common locations:
  - `/usr/local/bin/redis-server`
  - `/opt/homebrew/bin/redis-server`
  - `/usr/bin/redis-server`
- Starts Redis with daemon mode for background operation
- Recommends installation via Homebrew: `brew install redis`

### Linux (Ubuntu/Debian/CentOS)
- Searches for Redis in common locations:
  - `/usr/bin/redis-server`
  - `/usr/local/bin/redis-server`
  - `/snap/bin/redis-server`
  - `~/.local/bin/redis-server`
- Starts Redis with daemon mode for background operation
- Recommends installation via package manager: `sudo apt-get install redis-server`

### Windows
- Searches for Redis in common locations:
  - `C:\Program Files\Redis\redis-server.exe`
  - `C:\Program Files (x86)\Redis\redis-server.exe`
  - `C:\Redis\redis-server.exe`
  - `%LOCALAPPDATA%\Redis\redis-server.exe`
- Runs Redis server in foreground with proper process handling
- Recommends downloading from the official Redis website

## Configuration

The auto-start feature uses the same Redis configuration as the main application:

```json
{
  "redis": {
    "url": "redis://localhost:6379",
    "keyPrefix": "agimake:"
  }
}
```

## Error Handling

The auto-start feature includes comprehensive error handling:

- **Redis not found**: Provides platform-specific installation instructions
- **Connection refused**: Offers manual startup instructions
- **Permission denied**: Suggests checking Redis installation and permissions
- **Startup timeout**: Indicates Redis may have failed to start properly

## Manual Redis Management

While auto-start is convenient, you can also manage Redis manually:

### Start Redis manually
```bash
# macOS/Linux
redis-server

# With custom config
redis-server /path/to/redis.conf

# Windows
redis-server.exe
```

### Check if Redis is running
```bash
# Using redis-cli
redis-cli ping

# Using netstat (Unix)
netstat -an | grep 6379

# Using netstat (Windows)
netstat -an | findstr :6379
```

### Stop Redis
```bash
# Using redis-cli
redis-cli shutdown

# Or kill the process
pkill redis-server  # Unix
taskkill /f /im redis-server.exe  # Windows
```

## Troubleshooting

### Auto-start fails
1. Check if Redis is installed: `which redis-server` (Unix) or `where redis-server` (Windows)
2. Verify Redis is in your system PATH
3. Check permissions on Redis executable
4. Look for error messages in the console output

### Redis won't start
1. Check if port 6379 is already in use
2. Verify Redis configuration file (if using one)
3. Check system logs for Redis-related errors
4. Ensure you have sufficient permissions

### Connection issues
1. Verify Redis is running: `redis-cli ping`
2. Check firewall settings
3. Verify the URL in your configuration
4. Try connecting manually with `redis-cli -h localhost -p 6379`

## Best Practices

1. **Development**: Let AGImake manage Redis automatically for convenience
2. **Production**: Consider running Redis as a proper service/daemon
3. **Security**: Configure Redis with authentication in production
4. **Persistence**: Configure Redis persistence options if needed
5. **Memory**: Monitor Redis memory usage in production environments

## Integration Notes

The auto-start feature is transparent to the rest of the application. It:
- Doesn't affect existing Redis configurations
- Works with custom Redis URLs
- Handles both daemonized and foreground Redis processes
- Cleans up resources properly on shutdown
- Provides detailed logging for debugging