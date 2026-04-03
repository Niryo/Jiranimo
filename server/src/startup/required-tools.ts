import { spawnSync } from 'node:child_process';
import { parseClaudeCommand } from '../claude/command.js';
import type { ServerConfig } from '../config/types.js';

interface RequiredCliTool {
  name: string;
  command: string;
  executable: string;
  hint: string;
}

interface CommandCheckResult {
  available: boolean;
  reason?: string;
}

type CommandChecker = (program: string, args: string[]) => CommandCheckResult;

export function assertRequiredCliToolsAvailable(
  config: Pick<ServerConfig, 'claude'>,
  checker: CommandChecker = checkCommandAvailable,
): void {
  const missing = getRequiredCliTools(config)
    .map((tool) => {
      const result = checker(tool.executable, ['--version']);
      if (result.available) {
        return null;
      }

      const commandText = tool.command === tool.executable
        ? `command \`${tool.command}\``
        : `command \`${tool.command}\` (executable \`${tool.executable}\`)`;

      return `- ${tool.name}: ${commandText} ${result.reason ?? 'is unavailable'}. ${tool.hint}`;
    })
    .filter((message): message is string => !!message);

  if (missing.length > 0) {
    throw new Error([
      'Missing required CLI tools before starting Jiranimo:',
      ...missing,
    ].join('\n'));
  }
}

function getRequiredCliTools(config: Pick<ServerConfig, 'claude'>): RequiredCliTool[] {
  const claudeCommand = config.claude.command?.trim() || 'claude';
  const { program } = parseClaudeCommand(claudeCommand);

  return [
    {
      name: 'Claude Code CLI',
      command: claudeCommand,
      executable: program,
      hint: config.claude.command
        ? 'Fix `claude.command` or make sure that executable is installed and on PATH.'
        : 'Install Claude Code and make sure `claude` command is available.',
    },
    {
      name: 'GitHub CLI',
      command: 'gh',
      executable: 'gh',
      hint: 'Install GitHub CLI and make sure `gh` command is available.',
    },
  ];
}

function checkCommandAvailable(program: string, args: string[]): CommandCheckResult {
  const result = spawnSync(program, args, {
    stdio: 'ignore',
    env: process.env,
  });

  if (!result.error) {
    return { available: true };
  }

  const error = result.error as NodeJS.ErrnoException;
  if (error.code === 'ENOENT') {
    return {
      available: false,
      reason: program.includes('/') ? 'does not exist' : 'was not found in PATH',
    };
  }

  if (error.code === 'EACCES') {
    return {
      available: false,
      reason: 'is not executable',
    };
  }

  return {
    available: false,
    reason: `could not be started (${error.message})`,
  };
}

