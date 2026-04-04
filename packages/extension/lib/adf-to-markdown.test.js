import { describe, it, expect } from 'vitest';
const { adfToMarkdown } = require('./adf-to-markdown.js');

describe('adfToMarkdown', () => {
  it('returns empty string for null/undefined', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
  });

  it('converts a simple paragraph', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello world' }],
      }],
    };
    expect(adfToMarkdown(adf)).toBe('Hello world');
  });

  it('converts headings', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Subtitle' }] },
      ],
    };
    const result = adfToMarkdown(adf);
    expect(result).toContain('# Title');
    expect(result).toContain('### Subtitle');
  });

  it('converts bold text', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('**bold**');
  });

  it('converts italic text', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'italic', marks: [{ type: 'em' }] }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('*italic*');
  });

  it('converts inline code', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'code', marks: [{ type: 'code' }] }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('`code`');
  });

  it('converts links', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'click here',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('[click here](https://example.com)');
  });

  it('converts bullet lists', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }] },
        ],
      }],
    };
    const result = adfToMarkdown(adf);
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
  });

  it('converts ordered lists', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }] },
        ],
      }],
    };
    const result = adfToMarkdown(adf);
    expect(result).toContain('1. First');
    expect(result).toContain('2. Second');
  });

  it('converts code blocks', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'const x = 1;' }],
      }],
    };
    const result = adfToMarkdown(adf);
    expect(result).toContain('```typescript');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('```');
  });

  it('converts blockquotes', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('> quoted');
  });

  it('converts horizontal rule', () => {
    const adf = {
      type: 'doc',
      content: [{ type: 'rule' }],
    };
    expect(adfToMarkdown(adf)).toContain('---');
  });

  it('handles hardBreak', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'hardBreak' },
          { type: 'text', text: 'line2' },
        ],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('line1\nline2');
  });

  it('handles mentions', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'mention', attrs: { text: 'John' } }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('@John');
  });

  it('handles empty document', () => {
    const adf = { type: 'doc', content: [] };
    expect(adfToMarkdown(adf)).toBe('');
  });

  it('handles strikethrough', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'old', marks: [{ type: 'strike' }] }],
      }],
    };
    expect(adfToMarkdown(adf)).toContain('~~old~~');
  });
});
