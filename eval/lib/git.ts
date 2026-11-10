/**
 * Git process runner. An interface so cache/truth logic is tested with a
 * recording fake; the real one uses execFile (no shell, so no quoting or
 * injection issues with paths) and a hard timeout per command.
 */
import { execFile } from 'child_process';

export interface GitRunOptions {
  cwd: string;
  timeoutMs: number;
}

export interface GitRunner {
  run(args: readonly string[], opts: GitRunOptions): Promise<string>;
}

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_CLONE_TIMEOUT_MS = 15 * 60_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export function createExecGitRunner(): GitRunner {
  return {
    run(args, opts) {
      return new Promise((resolve, reject) => {
        execFile(
          'git',
          [...args],
          {
            cwd: opts.cwd,
            timeout: opts.timeoutMs,
            maxBuffer: 256 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
            // Never prompt for credentials: a prompt would hang until timeout.
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
          },
          (error, stdout, stderr) => {
            if (error !== null) {
              const reason = error.killed ? `timed out after ${opts.timeoutMs} ms` : error.message.split('\n')[0];
              reject(
                new GitError(`git ${args.slice(0, 4).join(' ')} failed: ${reason}; ${stderr.trim()}`, args, stderr)
              );
              return;
            }
            resolve(stdout);
          }
        );
      });
    }
  };
}
