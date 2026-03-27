import { createInterface } from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_FILENAME = 'jiranimo.config.json';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runSetup(): Promise<string> {
  console.log('\nWelcome to Jiranimo! Let\'s set up your configuration.\n');

  const repoPath = await prompt('Path to your repo/projects directory: ');

  if (!repoPath) {
    console.error('Repo path is required.');
    process.exit(1);
  }

  const resolvedPath = resolve(repoPath.replace(/^~/, homedir()));

  if (!existsSync(resolvedPath)) {
    console.error(`Directory not found: ${resolvedPath}`);
    process.exit(1);
  }

  const config = {
    repoPath: resolvedPath,
  };

  const configPath = resolve(process.cwd(), CONFIG_FILENAME);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`\nConfig saved to ${configPath}\n`);

  return configPath;
}

export function configExists(): boolean {
  const paths = [
    resolve(process.cwd(), CONFIG_FILENAME),
    resolve(homedir(), '.jiranimo', CONFIG_FILENAME),
  ];
  return paths.some(p => existsSync(p));
}
