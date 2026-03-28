import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pickRepo } from './repo-picker.js';

const mockExecute = vi.hoisted(() => vi.fn());

vi.mock('./claude/executor.js', () => ({
  executeClaudeCode: mockExecute,
}));

const baseTask = {
  key: 'PROJ-1',
  summary: 'Add user authentication',
  description: 'Implement OAuth login for the web app.',
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jiranimo-repopicker-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRepo(root: string, name: string, pkg?: { name?: string; description?: string }) {
  const repoPath = join(root, name);
  mkdirSync(join(repoPath, '.git'), { recursive: true });
  if (pkg) {
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify(pkg));
  }
  return repoPath;
}

describe('pickRepo', () => {
  it('returns single repo immediately without Claude call', async () => {
    makeRepo(root, 'my-app');

    const result = await pickRepo(root, baseTask);
    expect(result).toBe(join(root, 'my-app'));
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('throws when no repos found', async () => {
    await expect(pickRepo(root, baseTask)).rejects.toThrow('No git repositories found');
  });

  it('calls Claude with task and repo list when multiple repos exist', async () => {
    makeRepo(root, 'web-app', { name: 'web-app', description: 'Frontend React app' });
    makeRepo(root, 'api-server');

    mockExecute.mockResolvedValue({ success: true, resultText: 'web-app', durationMs: 100 });

    const result = await pickRepo(root, baseTask);

    expect(result).toBe(join(root, 'web-app'));
    expect(mockExecute).toHaveBeenCalledOnce();
    const callArgs = mockExecute.mock.calls[0][0] as { prompt: string; config: { model: string } };
    expect(callArgs.config.model).toBe('claude-haiku-4-5-20251001');
    expect(callArgs.prompt).toContain('PROJ-1');
    expect(callArgs.prompt).toContain('web-app');
  });

  it('throws when Claude returns an unrecognized repo name', async () => {
    makeRepo(root, 'web-app');
    makeRepo(root, 'api-server');

    mockExecute.mockResolvedValue({ success: true, resultText: 'nonexistent-repo', durationMs: 100 });

    await expect(pickRepo(root, baseTask)).rejects.toThrow('does not match any repository');
  });

  it('ignores directories without .git', async () => {
    mkdirSync(join(root, 'not-a-repo'));
    makeRepo(root, 'real-repo');

    const result = await pickRepo(root, baseTask);
    expect(result).toBe(join(root, 'real-repo'));
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('includes package.json description as hint in prompt', async () => {
    makeRepo(root, 'frontend', { description: 'Next.js website' });
    makeRepo(root, 'backend', { description: 'Express API server' });

    mockExecute.mockResolvedValue({ success: true, resultText: 'frontend', durationMs: 100 });

    await pickRepo(root, baseTask);

    const prompt = (mockExecute.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('Next.js website');
    expect(prompt).toContain('Express API server');
  });
});
