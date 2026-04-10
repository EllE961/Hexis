#!/usr/bin/env node

/**
 * Hexis MCP Server — Exposes the documentation graph to Claude Code.
 *
 * Tools:
 *   hexis_graph_overview   — Summary stats: node count, edges, groups, health
 *   hexis_search_nodes     — Fuzzy search nodes by title, type, tags, section
 *   hexis_get_node         — Full details for a specific node (content, connections, git)
 *   hexis_get_group        — All nodes in a group/section with stats
 *   hexis_get_connections   — Get all connections for a node with relationship types
 *   hexis_health_check     — Doc health: missing frontmatter, broken links, orphans
 *   hexis_git_status       — Branch info, recent commits, changed files
 *   hexis_find_orphans     — Nodes with zero connections
 *   hexis_find_stale       — Nodes not modified in N days
 *
 * Usage: node nebula/mcp-server.js
 * Register in .claude/settings.local.json under mcpServers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { buildGraph } from './server/graph-builder.js';
import { initGit, getCurrentBranch, getBranches, getCommitHistory } from './server/git-analyzer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PATH = (process.argv[2] || process.env.HEXIS_TARGET || resolve(__dirname)).replace(/\\/g, '/');

// Initialize git
initGit(REPO_PATH);

// Cache graph data (rebuilt on each request to stay fresh)
let graphCache = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5s cache

async function getGraph() {
  if (graphCache && Date.now() - cacheTime < CACHE_TTL) return graphCache;
  graphCache = await buildGraph(REPO_PATH);
  cacheTime = Date.now();
  return graphCache;
}

// ─── MCP Server ───

const server = new McpServer({
  name: 'hexis',
  version: '0.1.0',
});

// Tool: Graph overview
server.tool(
  'hexis_graph_overview',
  'Get a summary of the documentation graph: node counts by section/type/status, edge counts, health stats',
  {},
  async () => {
    const graph = await getGraph();
    const { nodes, edges } = graph;

    const bySection = {};
    const byType = {};
    const byStatus = {};
    let healthyCount = 0;

    for (const n of nodes) {
      bySection[n.section] = (bySection[n.section] || 0) + 1;
      byType[n.type] = (byType[n.type] || 0) + 1;
      byStatus[n.status] = (byStatus[n.status] || 0) + 1;
      if (n.hasValidFrontmatter) healthyCount++;
    }

    const edgesByType = {};
    for (const e of edges) {
      edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
    }

    const branch = await getCurrentBranch();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalNodes: nodes.length,
          totalEdges: edges.length,
          health: { valid: healthyCount, invalid: nodes.length - healthyCount },
          bySection,
          byType,
          byStatus,
          edgesByType,
          currentBranch: branch,
        }, null, 2),
      }],
    };
  }
);

// Tool: Search nodes
server.tool(
  'hexis_search_nodes',
  'Search documentation nodes by title, type, tags, or section. Returns matching nodes with metadata.',
  {
    query: z.string().describe('Search query — matches against title, type, tags, section'),
    limit: z.number().optional().default(20).describe('Max results to return'),
  },
  async ({ query, limit }) => {
    const graph = await getGraph();
    const q = query.toLowerCase();

    const results = graph.nodes
      .map(n => {
        const title = (n.title || n.label || '').toLowerCase();
        const type = (n.type || '').toLowerCase();
        const section = (n.section || '').toLowerCase();
        const tags = (n.tags || []).join(' ').toLowerCase();
        const all = `${title} ${type} ${section} ${tags}`;

        let score = 0;
        if (title.includes(q)) score += 3;
        if (type === q) score += 2;
        if (section === q) score += 1.5;
        if (tags.includes(q)) score += 1;
        if (all.includes(q)) score += 0.5;

        return { node: n, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => ({
        id: r.node.id,
        title: r.node.title,
        type: r.node.type,
        status: r.node.status,
        section: r.node.section,
        tags: r.node.tags,
        connections: r.node.connections,
        lastModified: r.node.lastModified,
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ query, resultCount: results.length, results }, null, 2),
      }],
    };
  }
);

// Tool: Get node details
server.tool(
  'hexis_get_node',
  'Get full details for a specific node: metadata, content, connections, git history',
  {
    path: z.string().describe('Node path (e.g. "research/general/git-branching-strategies.md")'),
  },
  async ({ path: nodePath }) => {
    const graph = await getGraph();
    const node = graph.nodes.find(n => n.id === nodePath);
    if (!node) {
      return { content: [{ type: 'text', text: `Node not found: ${nodePath}` }] };
    }

    // Read file content
    let content = '';
    try {
      const fullPath = resolve(REPO_PATH, nodePath);
      content = await readFile(fullPath, 'utf-8');
    } catch {}

    // Get connections
    const connections = graph.edges
      .filter(e => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        return src === nodePath || tgt === nodePath;
      })
      .map(e => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        return {
          target: src === nodePath ? tgt : src,
          type: e.type,
          direction: src === nodePath ? 'outgoing' : 'incoming',
        };
      });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: node.id,
          title: node.title,
          type: node.type,
          status: node.status,
          section: node.section,
          tags: node.tags,
          connections: connections.length,
          connectionDetails: connections,
          hasValidFrontmatter: node.hasValidFrontmatter,
          lastModified: node.lastModified,
          changeCount: node.changeCount,
          contributors: node.contributors,
          groupPath: node.groupPath,
          content,
        }, null, 2),
      }],
    };
  }
);

// Tool: Get group
server.tool(
  'hexis_get_group',
  'Get all nodes in a section/group with stats',
  {
    section: z.string().describe('Section name (e.g. "research", "engine") or group path (e.g. "research/general")'),
  },
  async ({ section }) => {
    const graph = await getGraph();

    const nodes = graph.nodes.filter(n => {
      if (n.section === section) return true;
      if (n.groupPath?.includes(section)) return true;
      return false;
    });

    const byType = {};
    const byStatus = {};
    for (const n of nodes) {
      byType[n.type] = (byType[n.type] || 0) + 1;
      byStatus[n.status] = (byStatus[n.status] || 0) + 1;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          section,
          nodeCount: nodes.length,
          byType,
          byStatus,
          nodes: nodes.map(n => ({
            id: n.id, title: n.title, type: n.type, status: n.status,
            connections: n.connections, lastModified: n.lastModified,
          })),
        }, null, 2),
      }],
    };
  }
);

// Tool: Get connections
server.tool(
  'hexis_get_connections',
  'Get all connections for a node with relationship details',
  {
    path: z.string().describe('Node path'),
  },
  async ({ path: nodePath }) => {
    const graph = await getGraph();
    const connections = graph.edges
      .filter(e => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        return src === nodePath || tgt === nodePath;
      })
      .map(e => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        const targetId = src === nodePath ? tgt : src;
        const targetNode = graph.nodes.find(n => n.id === targetId);
        return {
          target: targetId,
          targetTitle: targetNode?.title || targetId,
          type: e.type,
          direction: src === nodePath ? 'outgoing' : 'incoming',
          targetSection: targetNode?.section,
          targetType: targetNode?.type,
        };
      });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ path: nodePath, connectionCount: connections.length, connections }, null, 2),
      }],
    };
  }
);

// Tool: Health check
server.tool(
  'hexis_health_check',
  'Run a documentation health check: missing frontmatter, orphan nodes, stale docs',
  {},
  async () => {
    const graph = await getGraph();
    const { nodes, edges } = graph;

    const orphans = nodes.filter(n => n.connections === 0).map(n => n.id);
    const missingFrontmatter = nodes.filter(n => !n.hasValidFrontmatter).map(n => n.id);
    const deprecated = nodes.filter(n => n.status === 'deprecated').map(n => n.id);
    const drafts = nodes.filter(n => n.status === 'draft').map(n => n.id);

    const now = Date.now();
    const stale = nodes
      .filter(n => n.lastModified && (now - new Date(n.lastModified).getTime()) > 30 * 86400000)
      .map(n => ({ id: n.id, daysSinceModified: Math.floor((now - new Date(n.lastModified).getTime()) / 86400000) }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: nodes.length,
          healthy: nodes.length - missingFrontmatter.length,
          issues: {
            orphanNodes: orphans,
            missingFrontmatter,
            deprecated,
            drafts,
            staleOver30Days: stale,
          },
        }, null, 2),
      }],
    };
  }
);

// Tool: Git status
server.tool(
  'hexis_git_status',
  'Get git status: current branch, recent commits, all branches',
  {
    commitCount: z.number().optional().default(10).describe('Number of recent commits to return'),
  },
  async ({ commitCount }) => {
    const branch = await getCurrentBranch();
    const branches = await getBranches();
    const commits = await getCommitHistory(commitCount);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          currentBranch: branch,
          branches: branches.map(b => b.name),
          recentCommits: commits.map(c => ({
            hash: c.shortHash,
            message: c.message,
            author: c.author,
            date: c.date,
          })),
        }, null, 2),
      }],
    };
  }
);

// Tool: Find orphans
server.tool(
  'hexis_find_orphans',
  'Find nodes with zero connections — potential documentation islands',
  {},
  async () => {
    const graph = await getGraph();
    const orphans = graph.nodes
      .filter(n => n.connections === 0)
      .map(n => ({ id: n.id, title: n.title, type: n.type, section: n.section, status: n.status }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ orphanCount: orphans.length, orphans }, null, 2),
      }],
    };
  }
);

// Tool: Find stale
server.tool(
  'hexis_find_stale',
  'Find nodes not modified in the last N days',
  {
    days: z.number().optional().default(30).describe('Threshold in days'),
  },
  async ({ days }) => {
    const graph = await getGraph();
    const now = Date.now();
    const threshold = days * 86400000;

    const stale = graph.nodes
      .filter(n => n.lastModified && (now - new Date(n.lastModified).getTime()) > threshold)
      .sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified))
      .map(n => ({
        id: n.id, title: n.title, type: n.type, section: n.section,
        lastModified: n.lastModified,
        daysSince: Math.floor((now - new Date(n.lastModified).getTime()) / 86400000),
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ threshold: `${days} days`, staleCount: stale.length, stale }, null, 2),
      }],
    };
  }
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
