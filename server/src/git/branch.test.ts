import { describe, it, expect } from 'vitest';
import { slugify, branchName, commitType, commitMessage } from './branch.js';

describe('slugify', () => {
  it('converts to lowercase and replaces spaces with hyphens', () => {
    expect(slugify('Add User Avatar')).toBe('add-user-avatar');
  });

  it('removes special characters', () => {
    expect(slugify('Fix bug: crash on login!')).toBe('fix-bug-crash-on-login');
  });

  it('truncates to max length', () => {
    const long = 'this is a very long summary that should be truncated at forty chars';
    expect(slugify(long, 40).length).toBeLessThanOrEqual(40);
  });

  it('removes trailing hyphens after truncation', () => {
    // "a-b-c-d-e-f-g-h-i-j" truncated might end with hyphen
    const result = slugify('a b c d e f g h i j k l m n', 10);
    expect(result).not.toMatch(/-$/);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles unicode characters', () => {
    expect(slugify('Добавить аватар')).toBe('');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('hello   world---test')).toBe('hello-world-test');
  });
});

describe('branchName', () => {
  it('combines prefix, key, and slugified summary', () => {
    expect(branchName('jiranimo/', 'PROJ-123', 'Add user avatar'))
      .toBe('jiranimo/PROJ-123-add-user-avatar');
  });

  it('uses custom prefix', () => {
    expect(branchName('auto/', 'BUG-1', 'Fix crash'))
      .toBe('auto/BUG-1-fix-crash');
  });
});

describe('commitType', () => {
  it('maps Bug to fix', () => {
    expect(commitType('Bug')).toBe('fix');
  });

  it('maps Story to feat', () => {
    expect(commitType('Story')).toBe('feat');
  });

  it('maps Feature to feat', () => {
    expect(commitType('Feature')).toBe('feat');
  });

  it('maps Task to chore', () => {
    expect(commitType('Task')).toBe('chore');
  });

  it('maps unknown types to chore', () => {
    expect(commitType('Sub-task')).toBe('chore');
  });
});

describe('commitMessage', () => {
  it('formats conventional commit message', () => {
    expect(commitMessage('PROJ-123', 'Add user avatar', 'Story'))
      .toBe('feat(PROJ-123): Add user avatar');
  });

  it('uses fix for bugs', () => {
    expect(commitMessage('BUG-1', 'Fix crash', 'Bug'))
      .toBe('fix(BUG-1): Fix crash');
  });
});
