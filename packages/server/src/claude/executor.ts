import { spawn, type ChildProcess } from 'node:child_process';
import { OutputParser } from './output-parser.js';
import { parseClaudeCommand } from './command.js';
import type { ClaudeConfig } from '../config/types.js';
import type { ExecutionResult, ClaudeEvent } from './types.js';

export interface ExecutorOptions {
  prompt: string;
  cwd: string;
  config: ClaudeConfig;
  timeoutMs?: number;
  env?: Record<string, string>;
  resumeSessionId?: string;
  onEvent?: (event: ClaudeEvent) => void;
  onOutput?: (line: string) => void;
  onSpawn?: (child: ChildProcess) => void;
}

export async function executeClaudeCode(options: ExecutorOptions): Promise<ExecutionResult> {
  const { prompt, cwd, config, timeoutMs = 30 * 60 * 1000, onEvent, onOutput, resumeSessionId } = options;
  const startTime = Date.now();

  const { program, preArgs } = parseClaudeCommand(config.command);
  const args = [...preArgs, ...buildArgs(prompt, config, resumeSessionId)];

  return new Promise<ExecutionResult>((resolve, reject) => {
    const child: ChildProcess = spawn(program, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.onSpawn?.(child);

    const parser = new OutputParser();
    let resultEvent: ClaudeEvent | null = null;
    let stderr = '';

    parser.on('event', (event: ClaudeEvent) => {
      onEvent?.(event);
    });

    parser.on('result', (event: ClaudeEvent) => {
      resultEvent = event;
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      onOutput?.(text);
      parser.feed(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Timeout handling
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10_000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      parser.flush();
      const durationMs = Date.now() - startTime;

      if (resultEvent) {
        resolve({
          success: !resultEvent.isError && code === 0,
          resultText: resultEvent.text ?? '',
          sessionId: resultEvent.sessionId,
          costUsd: resultEvent.costUsd,
          durationMs,
        });
      } else {
        resolve({
          success: false,
          resultText: stderr || `Process exited with code ${code}`,
          durationMs,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
    });
  });
}

function buildArgs(prompt: string, config: ClaudeConfig, resumeSessionId?: string): string[] {
  const args: string[] = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  args.push('-p', prompt);

  if (config.model) {
    args.push('--model', config.model);
  }
  if (config.appendSystemPrompt) {
    args.push('--append-system-prompt', config.appendSystemPrompt);
  }
  if (config.effortLevel) {
    args.push('--effort', config.effortLevel);
  }

  return args;
}
