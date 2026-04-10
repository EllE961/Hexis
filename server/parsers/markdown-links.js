/**
 * Extract markdown links [text](path.md) from content.
 * Ignores links inside code blocks and HTML comments.
 * Returns array of { text, target } objects.
 */
export function extractMarkdownLinks(content) {
  const links = [];
  // Remove code blocks
  const cleaned = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const linkPattern = /\[([^\]]*)\]\(([^)]+\.md[^)]*)\)/g;
  let match;
  while ((match = linkPattern.exec(cleaned)) !== null) {
    const target = match[2].split('#')[0]; // Remove anchor
    if (!target.startsWith('http') && !target.includes('TODO') && !target.includes('path/to/')) {
      links.push({ text: match[1], target });
    }
  }
  return links;
}
