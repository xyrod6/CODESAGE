import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const execAsync = promisify(exec);

export interface RedisAutoStartOptions {
  redisUrl?: string;
  timeout?: number;
  log?: (message: string) => void;
}

export class RedisAutoStart {
  private redisProcess?: any;
  private options: Required<RedisAutoStartOptions>;

  constructor(options: RedisAutoStartOptions = {}) {
    this.options = {
      redisUrl: options.redisUrl || 'redis://localhost:6379',
      timeout: options.timeout || 30000,
      log: options.log || console.log,
    };
  }

  /**
   * Check if Redis is already running and accessible
   */
  async isRedisRunning(): Promise<boolean> {
    try {
      // Extract host and port from URL
      const url = new URL(this.options.redisUrl);
      const host = url.hostname || 'localhost';
      const port = url.port || '6379';

      // Try to connect using redis-cli or netcat
      const platformName = platform();

      if (platformName === 'win32') {
        // On Windows, try netstat
        try {
          const { stdout } = await execAsync(`netstat -an | findstr :${port}`);
          return stdout.includes(`${host}:${port}`) || stdout.includes(`0.0.0.0:${port}`) || stdout.includes(`127.0.0.1:${port}`);
        } catch {
          return false;
        }
      } else {
        // On Unix-like systems, try netcat or telnet
        try {
          // Try nc (netcat) first
          await execAsync(`nc -z -w3 ${host} ${port}`, { timeout: 3000 });
          return true;
        } catch {
          try {
            // Fallback to telnet
            await execAsync(`echo "" | timeout 3 telnet ${host} ${port}`, { timeout: 3000 });
            return true;
          } catch {
            return false;
          }
        }
      }
    } catch (error) {
      this.options.log(`Error checking Redis status: ${error}`);
      return false;
    }
  }

  /**
   * Find Redis server executable
   */
  private async findRedisExecutable(): Promise<string | null> {
    const platformName = platform();
    const possibleCommands = platformName === 'win32'
      ? ['redis-server.exe', 'redis-server.cmd', 'redis-server']
      : ['redis-server'];

    for (const cmd of possibleCommands) {
      try {
        // Check if command exists in PATH
        await execAsync(`which ${cmd}`, { timeout: 2000 });
        return cmd;
      } catch {
        continue;
      }
    }

    // Try common installation paths
    const commonPaths = this.getCommonRedisPaths(platformName);
    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    return null;
  }

  /**
   * Get common Redis installation paths based on platform
   */
  private getCommonRedisPaths(platformName: NodeJS.Platform): string[] {
    if (platformName === 'win32') {
      return [
        'C:\\Program Files\\Redis\\redis-server.exe',
        'C:\\Program Files (x86)\\Redis\\redis-server.exe',
        'C:\\Redis\\redis-server.exe',
        join(process.env.LOCALAPPDATA || '', 'Redis\\redis-server.exe'),
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Redis\\redis-server.exe'),
      ];
    } else if (platformName === 'darwin') {
      return [
        '/usr/local/bin/redis-server',
        '/opt/homebrew/bin/redis-server',
        '/usr/bin/redis-server',
        '/opt/redis/bin/redis-server',
      ];
    } else {
      return [
        '/usr/bin/redis-server',
        '/usr/local/bin/redis-server',
        '/snap/bin/redis-server',
        '/opt/redis/bin/redis-server',
        join(process.env.HOME || '', '.local/bin/redis-server'),
      ];
    }
  }

  /**
   * Start Redis server
   */
  async startRedisServer(): Promise<boolean> {
    const executable = await this.findRedisExecutable();

    if (!executable) {
      this.options.log('Redis server executable not found. Please install Redis.');
      this.options.log('Installation instructions:');
      this.options.log('  macOS: brew install redis');
      this.options.log('  Ubuntu/Debian: sudo apt-get install redis-server');
      this.options.log('  Windows: Download from https://redis.io/download');
      return false;
    }

    return new Promise((resolve) => {
      this.options.log(`Starting Redis server using: ${executable}`);

      const platformName = platform();
      const args = platformName === 'win32' ? [] : ['--daemonize yes'];

      this.redisProcess = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platformName !== 'win32',
      });

      if (platformName !== 'win32') {
        this.redisProcess.unref();
      }

      let output = '';
      let errorOutput = '';

      this.redisProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      this.redisProcess.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      this.redisProcess.on('error', (error: Error) => {
        this.options.log(`Failed to start Redis: ${error.message}`);
        resolve(false);
      });

      this.redisProcess.on('close', (code: number) => {
        if (code === 0) {
          this.options.log('Redis server started successfully');
          resolve(true);
        } else {
          this.options.log(`Redis server exited with code ${code}`);
          if (errorOutput) {
            this.options.log(`Error output: ${errorOutput}`);
          }
          resolve(false);
        }
      });

      // Handle daemonized Redis (Unix-like systems)
      if (platformName !== 'win32') {
        // Give it a moment to start
        setTimeout(async () => {
          if (await this.isRedisRunning()) {
            this.options.log('Redis server started successfully (daemonized)');
            resolve(true);
          } else {
            this.options.log('Redis server may have failed to start');
            resolve(false);
          }
        }, 2000);
      }
    });
  }

  /**
   * Wait for Redis to be ready
   */
  async waitForRedis(): Promise<boolean> {
    const startTime = Date.now();
    const interval = 1000; // Check every second

    while (Date.now() - startTime < this.options.timeout) {
      if (await this.isRedisRunning()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }

    return false;
  }

  /**
   * Auto-start Redis if not running
   */
  async ensureRedisRunning(): Promise<{ success: boolean; wasStarted: boolean; message: string }> {
    try {
      // Check if Redis is already running
      if (await this.isRedisRunning()) {
        return {
          success: true,
          wasStarted: false,
          message: 'Redis is already running'
        };
      }

      this.options.log('Redis is not running. Attempting to start it automatically...');

      // Try to start Redis
      const started = await this.startRedisServer();

      if (!started) {
        return {
          success: false,
          wasStarted: false,
          message: 'Failed to start Redis server. Please start it manually.'
        };
      }

      // Wait for Redis to be ready
      this.options.log('Waiting for Redis to be ready...');
      const ready = await this.waitForRedis();

      if (ready) {
        return {
          success: true,
          wasStarted: true,
          message: 'Redis started successfully and is ready'
        };
      } else {
        return {
          success: false,
          wasStarted: true,
          message: 'Redis started but is not responding. Check the logs.'
        };
      }
    } catch (error) {
      return {
        success: false,
        wasStarted: false,
        message: `Error ensuring Redis is running: ${error}`
      };
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    if (this.redisProcess && !this.redisProcess.killed) {
      try {
        this.redisProcess.kill();
      } catch (error) {
        this.options.log(`Error cleaning up Redis process: ${error}`);
      }
    }
  }
}