import { create } from 'zustand';
import { useEffect } from 'react';

export const useGraphStore = create((set, get) => ({
  nodes: [],
  edges: [],
  clusters: [],
  commits: [],
  branches: [],
  readmeMap: {},
  sectionColors: {},
  currentBranch: 'main',
  loading: true,
  connected: false,
  error: null,

  // Selection
  selectedNode: null,
  hoveredNode: null,
  selectedGroup: null,
  hoveredEdge: null,

  setSelectedGroup: (group) => set({ selectedGroup: group, selectedNode: null }),
  setSelectedNode: (nodeId) => set({ selectedNode: nodeId }),
  setHoveredNode: (nodeId) => set({ hoveredNode: nodeId }),
  setHoveredEdge: (edge) => set({ hoveredEdge: edge }),

  // Filters
  filters: {
    sections: [], types: [], statuses: [],
    recency: null, connections: null, health: null,
  },

  toggleFilter: (category, value) => {
    const filters = { ...get().filters };
    if (category === 'recency' || category === 'connections' || category === 'health') {
      filters[category] = filters[category] === value ? null : value;
    } else {
      const arr = [...(filters[category] || [])];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(value);
      filters[category] = arr;
    }
    set({ filters });
  },

  clearFilters: () => set({ filters: { sections: [], types: [], statuses: [], recency: null, connections: null, health: null } }),

  // Command palette
  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),

  // ─── Git status ───
  gitStatus: null,  // { current, staged, modified, not_added, deleted, created, conflicted, ahead, behind }
  showChanges: true,
  gitPanelOpen: false,
  showEdges: true,
  pendingMove: null,   // { nodeId, fromPath, toGroup, toPath, snapBack: {x,y} }
  dragOverGroup: null, // group key being hovered during node drag
  groupMinSizes: {},   // { [groupKey]: { minW, minH, originX?, originY? } } in graph-space units

  toggleGitPanel: () => set({ gitPanelOpen: !get().gitPanelOpen }),
  toggleShowChanges: () => set({ showChanges: !get().showChanges }),
  toggleShowEdges: () => set({ showEdges: !get().showEdges }),
  setPendingMove: (move) => set({ pendingMove: move }),
  setDragOverGroup: (key) => set({ dragOverGroup: key }),
  setGroupMinSize: (key, minW, minH, originX, originY) => {
    const existing = get().groupMinSizes[key];
    set({
      groupMinSizes: {
        ...get().groupMinSizes,
        [key]: {
          minW, minH,
          originX: originX ?? existing?.originX,
          originY: originY ?? existing?.originY,
        },
      },
    });
  },

  moveFile: async (from, to) => {
    try {
      const res = await fetch('/api/file/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, updateLinks: true }),
      });
      const data = await res.json();
      if (data.ok) {
        get().fetchGitStatus();
        // Graph rebuilds automatically via watcher → SSE → applyDelta
      }
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  fetchGitStatus: async () => {
    try {
      const res = await fetch('/api/git/status');
      const status = await res.json();
      set({ gitStatus: status, currentBranch: status.current || get().currentBranch });
    } catch {}
  },

  // ─── File save ───
  saveFile: async (path, content) => {
    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });
      const data = await res.json();
      if (data.ok) {
        // Refresh git status after save
        get().fetchGitStatus();
      }
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // ─── Git actions ───
  gitAction: async (action, body = {}) => {
    try {
      const isDelete = action === 'branch' && body._delete;
      const method = isDelete ? 'DELETE' : 'POST';
      const url = `/api/git/${action}`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      // Refresh status and graph after any git action
      get().fetchGitStatus();
      get().fetchGraph();
      return result;
    } catch (err) {
      return { error: err.message };
    }
  },

  // Load graph
  fetchGraph: async () => {
    try {
      set({ loading: true });
      const res = await fetch('/api/graph');
      const data = await res.json();
      set({
        nodes: data.nodes,
        edges: data.edges,
        clusters: data.clusters,
        commits: data.commits || [],
        readmeMap: data.readmeMap || {},
        sectionColors: data.sectionColors || {},
        branches: data.branches || [],
        currentBranch: data.currentBranch || 'main',
        loading: false,
      });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  applyDelta: async () => {
    await get().fetchGraph();
    await get().fetchGitStatus();
  },
}));

/** Check if a node passes the current filters */
export function isNodeVisible(node, filters) {
  if (filters.sections.length > 0 && !filters.sections.includes(node.section)) return false;
  if (filters.types.length > 0 && !filters.types.includes(node.type)) return false;
  if (filters.statuses.length > 0 && !filters.statuses.includes(node.status)) return false;
  if (filters.recency && node.lastModified) {
    const days = Math.floor((Date.now() - new Date(node.lastModified).getTime()) / 86400000);
    if (filters.recency === 'week' && days > 7) return false;
    if (filters.recency === 'month' && days > 30) return false;
    if (filters.recency === 'quarter' && days > 90) return false;
    if (filters.recency === 'stale' && days <= 90) return false;
  }
  if (filters.connections === 'orphan' && (node.connections || 0) > 0) return false;
  if (filters.connections === 'hub' && (node.connections || 0) < 3) return false;
  if (filters.health === 'healthy' && !node.hasValidFrontmatter) return false;
  if (filters.health === 'unhealthy' && node.hasValidFrontmatter) return false;
  return true;
}

/** Hook to connect to SSE and keep graph updated */
export function useSSE() {
  const applyDelta = useGraphStore(s => s.applyDelta);
  const fetchGitStatus = useGraphStore(s => s.fetchGitStatus);

  useEffect(() => {
    // Fetch git status on mount
    fetchGitStatus();

    const eventSource = new EventSource('/events');
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          useGraphStore.setState({ connected: true });
        } else if (data.type === 'fileChange') {
          applyDelta(data);
        } else if (data.type === 'branchChange') {
          useGraphStore.setState({ currentBranch: data.branch });
          applyDelta(data);
        }
      } catch {}
    };
    eventSource.onerror = () => {
      useGraphStore.setState({ connected: false });
    };
    return () => eventSource.close();
  }, [applyDelta, fetchGitStatus]);
}
