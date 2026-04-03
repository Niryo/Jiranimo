export interface ClaudeCommandParts {
  program: string;
  preArgs: string[];
}

export function parseClaudeCommand(command?: string): ClaudeCommandParts {
  const commandStr = command?.trim() || 'claude';
  const commandParts = commandStr.split(/\s+/).filter(Boolean);

  if (commandParts.length === 0) {
    throw new Error('Claude command cannot be empty');
  }

  return {
    program: commandParts[0]!,
    preArgs: commandParts.slice(1),
  };
}
