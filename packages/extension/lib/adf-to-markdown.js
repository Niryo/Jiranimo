/**
 * Converts Atlassian Document Format (ADF) to Markdown.
 * Handles common node types: paragraph, heading, bulletList, orderedList,
 * codeBlock, blockquote, text with marks (bold, italic, code, link).
 */

// @ts-check

/**
 * @param {object|null|undefined} adf - ADF document object
 * @returns {string} Markdown text
 */
function adfToMarkdown(adf) {
  if (!adf || typeof adf !== 'object') return '';
  if (adf.type === 'doc' && Array.isArray(adf.content)) {
    return adf.content.map(node => convertNode(node)).join('\n\n');
  }
  return '';
}

/**
 * @param {object} node
 * @returns {string}
 */
function convertNode(node) {
  if (!node || !node.type) return '';

  switch (node.type) {
    case 'paragraph':
      return convertInlineContent(node.content);

    case 'heading': {
      const level = node.attrs?.level || 1;
      const prefix = '#'.repeat(Math.min(level, 6));
      return `${prefix} ${convertInlineContent(node.content)}`;
    }

    case 'bulletList':
      return (node.content || [])
        .map(item => `- ${convertNode(item)}`)
        .join('\n');

    case 'orderedList':
      return (node.content || [])
        .map((item, i) => `${i + 1}. ${convertNode(item)}`)
        .join('\n');

    case 'listItem':
      return (node.content || []).map(convertNode).join('\n');

    case 'codeBlock': {
      const lang = node.attrs?.language || '';
      const code = convertInlineContent(node.content);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case 'blockquote':
      return (node.content || [])
        .map(child => `> ${convertNode(child)}`)
        .join('\n');

    case 'rule':
      return '---';

    case 'table':
      return convertTable(node);

    case 'mediaSingle':
    case 'mediaGroup':
      return '[media attachment]';

    case 'panel': {
      const panelType = node.attrs?.panelType || 'info';
      const content = (node.content || []).map(convertNode).join('\n');
      return `> **${panelType.toUpperCase()}:** ${content}`;
    }

    default:
      // Fallback: try to extract text content
      if (node.content) {
        return (Array.isArray(node.content) ? node.content : []).map(convertNode).join('');
      }
      return '';
  }
}

/**
 * @param {Array|undefined} content
 * @returns {string}
 */
function convertInlineContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(convertInlineNode).join('');
}

/**
 * @param {object} node
 * @returns {string}
 */
function convertInlineNode(node) {
  if (!node) return '';

  if (node.type === 'text') {
    let text = node.text || '';
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        switch (mark.type) {
          case 'strong':
            text = `**${text}**`;
            break;
          case 'em':
            text = `*${text}*`;
            break;
          case 'code':
            text = `\`${text}\``;
            break;
          case 'link':
            text = `[${text}](${mark.attrs?.href || ''})`;
            break;
          case 'strike':
            text = `~~${text}~~`;
            break;
        }
      }
    }
    return text;
  }

  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return `@${node.attrs?.text || 'user'}`;
  if (node.type === 'emoji') return node.attrs?.shortName || '';
  if (node.type === 'inlineCard') return `[${node.attrs?.url || 'link'}]`;

  return '';
}

/**
 * @param {object} tableNode
 * @returns {string}
 */
function convertTable(tableNode) {
  if (!tableNode.content) return '';
  const rows = tableNode.content.map(row => {
    if (!row.content) return [];
    return row.content.map(cell => convertInlineContent(cell.content));
  });
  if (rows.length === 0) return '';

  const header = rows[0];
  const separator = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
  ];
  for (let i = 1; i < rows.length; i++) {
    lines.push(`| ${rows[i].join(' | ')} |`);
  }
  return lines.join('\n');
}

// Export for both Node.js (testing) and browser (content script)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { adfToMarkdown };
} else if (typeof globalThis !== 'undefined') {
  globalThis.adfToMarkdown = adfToMarkdown;
}
