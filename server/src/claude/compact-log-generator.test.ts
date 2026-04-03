import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateCompactLog } from './compact-log-generator.js';
import { executeClaudeCode } from './executor.js';

vi.mock('./executor.js', () => ({
  executeClaudeCode: vi.fn(),
}));

describe('generateCompactLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a manual summary prompt from the execution log', async () => {
    vi.mocked(executeClaudeCode).mockResolvedValue({
      success: true,
      resultText: '- Updated the target file\n- Finished successfully',
      durationMs: 100,
    });

    const logContent = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will inspect the repository first.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/repo/src/app.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Completed the task.',
        cost_usd: 0.42,
      }),
    ].join('\n');

    const result = await generateCompactLog(logContent, 'Test task', { model: 'claude-sonnet-4-6' }, '/tmp/repo');

    expect(result).toBe('- Updated the target file\n- Finished successfully');
    expect(executeClaudeCode).toHaveBeenCalledOnce();
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0]).toMatchObject({
      cwd: '/tmp/repo',
      config: { model: 'claude-sonnet-4-6' },
    });
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('Task: "Test task"');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('[Claude] I will inspect the repository first.');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('[Tool] Read(/tmp/repo/src/app.ts)');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('[Result: success (cost: $0.4200)]');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('Do not spend bullets on routine workflow boilerplate');
  });

  it('filters routine git, PR, and Jira workflow actions from the summarization input', async () => {
    vi.mocked(executeClaudeCode).mockResolvedValue({
      success: true,
      resultText: '- Created the requested file\n- Completed successfully',
      durationMs: 100,
    });

    const logContent = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/repo/feature.txt' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'git -C /tmp/repo remote show origin' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'cd /tmp/repo && git add feature.txt && git commit -m \"feat\"' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'cd /tmp/repo && gh pr create --draft --title \"[PROJ] feat\"' } },
            { type: 'tool_use', name: 'mcp__jiranimo__jiranimo_complete', input: { task_key: 'PROJ-1' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I created the requested file at the repo root.' },
          ],
        },
      }),
    ].join('\n');

    await generateCompactLog(logContent, 'Filter boilerplate', {}, '/tmp/repo');

    const prompt = vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt ?? '';
    const executionLog = prompt.split('Execution log:\n')[1] ?? '';
    expect(executionLog).toContain('[Tool] Write(/tmp/repo/feature.txt)');
    expect(executionLog).toContain('[Claude] I created the requested file at the repo root.');
    expect(executionLog).not.toContain('git add');
    expect(executionLog).not.toContain('git commit');
    expect(executionLog).not.toContain('remote show origin');
    expect(executionLog).not.toContain('gh pr create');
    expect(executionLog).not.toContain('jiranimo_complete');
  });

  it('returns a fallback message when the log has no readable conversation content', async () => {
    const result = await generateCompactLog('{"type":"system","subtype":"init"}', 'Empty task', {}, '/tmp/repo');

    expect(result).toBe('No conversation content found in log.');
    expect(executeClaudeCode).not.toHaveBeenCalled();
  });
});
