import { join, dirname, resolve } from 'path';
import { scanDirectory } from './parsers/directory.js';
import { parseFrontmatter } from './parsers/frontmatter.js';
import { extractMarkdownLinks } from './parsers/markdown-links.js';
import { getFileMetrics } from './git-analyzer.js';

// Known section colors — unknown sections get auto-assigned from the palette
const KNOWN_COLORS = {
  engine: '#3B82F6',
  game: '#10B981',
  research: '#8B5CF6',
  decisions: '#F59E0B',
  shared: '#14B8A6',
  templates: '#6B7280',
};

// Palette for auto-assigning colors to unknown top-level directories
const COLOR_PALETTE = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#14B8A6',
  '#EC4899', '#F97316', '#06B6D4', '#84CC16', '#A855F7',
  '#EF4444', '#0EA5E9', '#D946EF', '#FBBF24', '#6366F1',
];

const autoColorMap = {};
let colorIdx = 0;

function getSectionColor(section) {
  if (KNOWN_COLORS[section]) return KNOWN_COLORS[section];
  if (!autoColorMap[section]) {
    autoColorMap[section] = COLOR_PALETTE[colorIdx % COLOR_PALETTE.length];
    colorIdx++;
  }
  return autoColorMap[section];
}

/** Get the top-level section from a file path — fully dynamic, no hardcoded list */
function getSection(filePath) {
  const parts = filePath.split('/');
  if (parts.length === 1) return '.'; // root-level file
  return parts[0]; // whatever the top-level dir is
}

/** Build the full directory ancestry for hierarchical grouping.
 *  "research/general/git-branching.md" → ["research", "research/general"]
 *  "README.md" → []
 */
function getGroupPath(filePath) {
  const parts = filePath.split('/');
  if (parts.length <= 1) return [];
  const path = [];
  for (let i = 1; i < parts.length; i++) {
    path.push(parts.slice(0, i).join('/'));
  }
  return path;
}

/**
 * Build the full graph from the repository.
 * Returns { nodes, edges, clusters, commits, readmeMap, sectionColors }
 */
export async function buildGraph(repoPath) {
  const entries = await scanDirectory(repoPath);
  const mdFiles = entries.filter(e => !e.isDirectory);
  const directories = entries.filter(e => e.isDirectory);

  // Build nodes
  const nodes = [];
  const nodeMap = new Map();

  for (const file of mdFiles) {
    const fullPath = join(repoPath, file.path);
    const { frontmatter, body, hasValidFrontmatter } = await parseFrontmatter(fullPath);
    const gitMetrics = await getFileMetrics(file.path);
    const section = getSection(file.path);

    const node = {
      id: file.path,
      label: file.name.replace('.md', ''),
      type: frontmatter.type || 'unknown',
      status: frontmatter.status || 'unknown',
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      directory: file.directory,
      section,
      groupPath: getGroupPath(file.path),
      title: frontmatter.title || file.name,
      hasValidFrontmatter,

      // Git metrics
      lastModified: gitMetrics.lastModified,
      changeCount: gitMetrics.changeCount,
      contributors: gitMetrics.contributors,
      age: gitMetrics.age,

      // Visual
      color: getSectionColor(section),
      opacity: frontmatter.status === 'deprecated' ? 0.3
        : frontmatter.status === 'draft' ? 0.6
        : 1.0,

      // For edge extraction
      _links: extractMarkdownLinks(body),
      _related: Array.isArray(frontmatter.related) ? frontmatter.related : [],
      _appliedTo: Array.isArray(frontmatter.applied_to) ? frontmatter.applied_to : [],
    };

    nodes.push(node);
    nodeMap.set(file.path, node);
  }

  // Build edges
  const edges = [];
  const edgeSet = new Set();

  function addEdge(source, target, type, label = '') {
    const key = `${source}|${target}|${type}`;
    const reverseKey = `${target}|${source}|${type}`;
    if (edgeSet.has(key) || edgeSet.has(reverseKey)) return;
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    edgeSet.add(key);
    edges.push({ source, target, type, label, strength: type === 'shared-tag' ? 0.1 : 0.3 });
  }

  for (const node of nodes) {
    // Markdown links
    for (const link of node._links) {
      const resolvedTarget = resolve(dirname(join(repoPath, node.id)), link.target)
        .replace(/\\/g, '/')
        .replace(repoPath.replace(/\\/g, '/') + '/', '');
      addEdge(node.id, resolvedTarget, 'markdown-link', link.text);
    }

    // Frontmatter related
    for (const rel of node._related) {
      addEdge(node.id, rel, 'frontmatter-related');
    }

    // Applied-to (research → doc/ADR)
    for (const applied of node._appliedTo) {
      addEdge(node.id, applied, 'applied-to');
    }

    // Shared tags (only connect nodes in different sections to avoid clutter)
    for (const otherNode of nodes) {
      if (otherNode.id === node.id) continue;
      if (otherNode.section === node.section) continue;
      const sharedTags = node.tags.filter(t => otherNode.tags.includes(t) && t !== 'index');
      if (sharedTags.length >= 2) {
        addEdge(node.id, otherNode.id, 'shared-tag', sharedTags.join(', '));
      }
    }
  }

  // Compute connection count
  const connectionCount = new Map();
  for (const edge of edges) {
    connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
  }
  for (const node of nodes) {
    const connections = connectionCount.get(node.id) || 0;
    node.size = Math.min(6 + connections * 1.5, 20);
    node.connections = connections;
  }

  // Separate README nodes — they become group metadata
  const readmeMap = {};
  const filteredNodes = [];
  for (const node of nodes) {
    if (node.label === 'README') {
      readmeMap[node.section] = {
        title: node.title,
        id: node.id,
        tags: node.tags,
        status: node.status,
      };
    } else {
      filteredNodes.push(node);
    }
  }

  const filteredNodeIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = edges.filter(e => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target));

  const clusters = directories.map(d => ({
    id: d.path,
    label: d.name,
    section: getSection(d.path),
    color: getSectionColor(getSection(d.path)),
  }));

  // Collect all discovered section colors for the client
  const sectionColors = {};
  for (const node of filteredNodes) {
    sectionColors[node.section] = getSectionColor(node.section);
  }

  // Clean internal fields
  for (const node of nodes) {
    delete node._links;
    delete node._related;
    delete node._appliedTo;
  }

  return { nodes: filteredNodes, edges: filteredEdges, clusters, readmeMap, sectionColors };
}
