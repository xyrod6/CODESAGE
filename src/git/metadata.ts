import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface GitContributor {
  name: string;
  commits: number;
}

export interface GitMetadata {
  lastCommitSha?: string;
  lastCommitAt?: string;
  churnCount?: number;
  topContributors?: GitContributor[];
  stabilityScore?: number;
  freshnessDays?: number;
  ownershipConfidence?: number;
}

class GitMetadataService {
  private cache = new Map<string, GitMetadata | null>();
  private availabilityChecked = false;
  private gitAvailable = false;

  async getMetadata(filepath: string, fileHash?: string): Promise<GitMetadata | null> {
    if (!config.git?.enabled) {
      return null;
    }

    if (!(await this.ensureGitAvailable())) {
      return null;
    }

    const lastCommit = await this.getLastCommit(filepath);
    const cacheKey = this.buildCacheKey(filepath, fileHash, lastCommit?.sha);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) || null;
    }

    const history = await this.getHistory(filepath);
    const churnCount = history.length;

    const contributorCounts = new Map<string, number>();
    for (const entry of history) {
      contributorCounts.set(entry.author, (contributorCounts.get(entry.author) || 0) + 1);
    }

    const topContributors = Array.from(contributorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, commits]) => ({ name, commits }));

    const totalCommits = history.length || topContributors.reduce((sum, c) => sum + c.commits, 0);
    const ownershipConfidence = totalCommits > 0 ? (topContributors[0]?.commits || 0) / totalCommits : 0;

    const freshnessDays = lastCommit?.timestamp
      ? Math.round((Date.now() - lastCommit.timestamp * 1000) / MS_PER_DAY)
      : undefined;

    const metadata: GitMetadata = {
      lastCommitSha: lastCommit?.sha,
      lastCommitAt: lastCommit?.timestamp ? new Date(lastCommit.timestamp * 1000).toISOString() : undefined,
      churnCount,
      topContributors,
      stabilityScore: this.calculateStabilityScore(churnCount),
      freshnessDays,
      ownershipConfidence,
    };

    this.cache.set(cacheKey, metadata);
    return metadata;
  }

  private buildCacheKey(filepath: string, fileHash?: string, lastCommitSha?: string): string {
    const hashPart = fileHash || 'no-hash';
    const commitPart = lastCommitSha || 'no-commit';
    return `${filepath}:${hashPart}:${commitPart}`;
  }

  private async ensureGitAvailable(): Promise<boolean> {
    if (this.availabilityChecked) {
      return this.gitAvailable;
    }

    this.availabilityChecked = true;

    try {
      const { stdout } = await execFileAsync(config.git.gitBinary, ['rev-parse', '--is-inside-work-tree'], {
        cwd: process.cwd(),
      });

      this.gitAvailable = stdout.trim() === 'true';
    } catch (error) {
      this.gitAvailable = false;
      console.error('Git metadata disabled (git unavailable or not a repo):', error instanceof Error ? error.message : error);
    }

    return this.gitAvailable;
  }

  private async getLastCommit(filepath: string): Promise<{ sha?: string; timestamp?: number } | null> {
    try {
      const { stdout } = await execFileAsync(
        config.git.gitBinary,
        ['log', '-n', '1', '--format=%H|%ct', '--', filepath],
        { cwd: process.cwd() },
      );

      const line = stdout.trim();
      if (!line) {
        return null;
      }

      const [sha, ts] = line.split('|');
      return { sha, timestamp: ts ? parseInt(ts, 10) : undefined };
    } catch {
      return null;
    }
  }

  private async getHistory(filepath: string): Promise<Array<{ sha: string; author: string }>> {
    try {
      const args = [
        'log',
        '-n',
        `${config.git.historyDepth}`,
        '--format=%H|%an',
      ];

      if (config.git.sampleWindowDays > 0) {
        args.push(`--since=${config.git.sampleWindowDays} days ago`);
      }

      args.push('--', filepath);

      const { stdout } = await execFileAsync(config.git.gitBinary, args, { cwd: process.cwd() });
      const lines = stdout.trim().split('\n').filter(Boolean);

      return lines.map(line => {
        const [sha, author] = line.split('|');
        return { sha, author: author || 'unknown' };
      });
    } catch {
      return [];
    }
  }

  private calculateStabilityScore(churnCount: number): number {
    // Higher churn means lower stability; keep value in (0,1]
    return 1 / (1 + churnCount);
  }
}

export const gitMetadata = new GitMetadataService();
