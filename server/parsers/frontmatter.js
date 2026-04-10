import matter from 'gray-matter';
import { readFile } from 'fs/promises';

export async function parseFrontmatter(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');
    const { data, content: body } = matter(content);
    return {
      frontmatter: data,
      body,
      hasValidFrontmatter: !!(data.title && data.type),
    };
  } catch {
    return { frontmatter: {}, body: '', hasValidFrontmatter: false };
  }
}
