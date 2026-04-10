/**
 * Editor Store — manages open files, tabs, and file content.
 */

import { create } from 'zustand';
import { useLocalHistoryStore } from './localHistoryStore.js';

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export const useEditorStore = create((set, get) => ({
  // Open tabs: [{ path, name, content, dirty, cursorLine, cursorCol }]
  tabs: [],
  activeTab: null,  // file path of active tab
  recentFiles: [],  // last 10 opened file paths

  // Open a file in the editor
  openFile: async (filePath) => {
    const existing = get().tabs.find(t => t.path === filePath);
    if (existing) {
      set({ activeTab: filePath });
      return;
    }

    // Read file content
    let content = '';
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        content = await invoke('read_file', { path: filePath });
      } else {
        const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        content = data.content || '';
      }
    } catch (err) {
      content = `// Error loading file: ${err.message}`;
    }

    const name = filePath.split('/').pop();
    const ext = name.includes('.') ? name.split('.').pop() : '';

    // Track in recent files (most recent first, max 10)
    const recent = [filePath, ...get().recentFiles.filter(p => p !== filePath)].slice(0, 10);

    set({
      tabs: [...get().tabs, {
        path: filePath,
        name,
        extension: ext,
        content,
        savedContent: content,
        dirty: false,
        cursorLine: 0,
        cursorCol: 0,
      }],
      activeTab: filePath,
      recentFiles: recent,
    });
  },

  // Close a tab
  closeTab: (filePath) => {
    const tabs = get().tabs.filter(t => t.path !== filePath);
    const wasActive = get().activeTab === filePath;
    set({
      tabs,
      activeTab: wasActive ? (tabs.length > 0 ? tabs[tabs.length - 1].path : null) : get().activeTab,
    });
  },

  // Close all tabs
  closeAll: () => set({ tabs: [], activeTab: null }),

  // Close all except the given tab
  closeOthers: (filePath) => {
    set({
      tabs: get().tabs.filter(t => t.path === filePath),
      activeTab: filePath,
    });
  },

  // Close tabs to the right of the given tab
  closeToRight: (filePath) => {
    const idx = get().tabs.findIndex(t => t.path === filePath);
    if (idx === -1) return;
    const tabs = get().tabs.slice(0, idx + 1);
    const active = get().activeTab;
    const activeStillOpen = tabs.some(t => t.path === active);
    set({
      tabs,
      activeTab: activeStillOpen ? active : filePath,
    });
  },

  // Update content (from editor changes)
  updateContent: (filePath, content) => {
    set({
      tabs: get().tabs.map(t =>
        t.path === filePath ? { ...t, content, dirty: content !== t.savedContent } : t
      ),
    });
  },

  // Save file
  saveFile: async (filePath) => {
    const tab = get().tabs.find(t => t.path === filePath);
    if (!tab || !tab.dirty) return;

    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('write_file', { path: filePath, content: tab.content });
      } else {
        await fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content: tab.content }),
        });
      }

      set({
        tabs: get().tabs.map(t =>
          t.path === filePath ? { ...t, savedContent: tab.content, dirty: false } : t
        ),
      });

      // Local history snapshot (fire-and-forget, survives page reload)
      try {
        useLocalHistoryStore.getState().snapshot(filePath, tab.content);
      } catch { /* non-fatal */ }
    } catch (err) {
      console.error('Save failed:', err);
    }
  },

  // Save every dirty tab in parallel.
  saveAll: async () => {
    const dirtyTabs = get().tabs.filter((t) => t.dirty);
    if (dirtyTabs.length === 0) return;
    await Promise.all(dirtyTabs.map((t) => get().saveFile(t.path)));
  },

  // Update cursor position
  setCursor: (filePath, line, col) => {
    set({
      tabs: get().tabs.map(t =>
        t.path === filePath ? { ...t, cursorLine: line, cursorCol: col } : t
      ),
    });
  },

  // Set active tab
  setActiveTab: (filePath) => set({ activeTab: filePath }),

  // Create a new empty file and open it in the editor
  createFile: async (filePath) => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('write_file', { path: filePath, content: '' });
      } else {
        await fetch('/api/file/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath }),
        });
      }
    } catch (err) {
      console.error('Create file failed:', err);
      return;
    }

    // Open the newly created file in the editor
    await get().openFile(filePath);
  },

  // Delete a file from disk and close its tab
  deleteFile: async (filePath) => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('delete_file', { path: filePath });
      } else {
        await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
          method: 'DELETE',
        });
      }
    } catch (err) {
      console.error('Delete file failed:', err);
      return;
    }

    // Close the tab if it was open
    get().closeTab(filePath);
  },

  // Rename/move a file and update its tab.
  //
  // Server endpoint expects { from, to }; Tauri command expects
  // { oldPath, newPath } (its param names). We map both correctly.
  // Returns { ok, error? } so callers can rollback optimistic updates.
  renameFile: async (oldPath, newPath) => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('rename_file', { oldPath, newPath });
      } else {
        const res = await fetch('/api/file/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: oldPath, to: newPath }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
      }
    } catch (err) {
      console.error('Rename file failed:', err);
      return { ok: false, error: err.message || String(err) };
    }

    const newName = newPath.split('/').pop();
    const newExt = newName.includes('.') ? newName.split('.').pop() : '';

    set({
      tabs: get().tabs.map(t =>
        t.path === oldPath
          ? { ...t, path: newPath, name: newName, extension: newExt }
          : t
      ),
      activeTab: get().activeTab === oldPath ? newPath : get().activeTab,
      recentFiles: get().recentFiles.map(p => p === oldPath ? newPath : p),
    });
    return { ok: true };
  },

  // ─── Folder operations (for drag-drop of groups + context menus) ───

  createFolder: async (folderPath) => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('create_folder', { path: folderPath });
      } else {
        const res = await fetch('/api/folder/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: folderPath }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
      }
      return { ok: true };
    } catch (err) {
      console.error('Create folder failed:', err);
      return { ok: false, error: err.message || String(err) };
    }
  },

  moveFolder: async (from, to) => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('move_folder', { from, to });
      } else {
        const res = await fetch('/api/folder/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
      }
      // Close any open tabs whose path was under the old folder
      const prefix = from.endsWith('/') ? from : from + '/';
      set({
        tabs: get().tabs.map(t =>
          t.path === from || t.path.startsWith(prefix)
            ? { ...t, path: t.path.replace(from, to) }
            : t
        ),
      });
      return { ok: true };
    } catch (err) {
      console.error('Move folder failed:', err);
      return { ok: false, error: err.message || String(err) };
    }
  },

  deleteFolder: async (folderPath) => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('delete_folder', { path: folderPath });
      } else {
        const res = await fetch(`/api/folder?path=${encodeURIComponent(folderPath)}&recursive=true`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
      }
      // Close any tabs under the deleted folder
      const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
      const toClose = get().tabs.filter(t => t.path === folderPath || t.path.startsWith(prefix));
      for (const t of toClose) get().closeTab(t.path);
      return { ok: true };
    } catch (err) {
      console.error('Delete folder failed:', err);
      return { ok: false, error: err.message || String(err) };
    }
  },

  // Re-read file content from disk (for external changes)
  reloadFile: async (filePath) => {
    const tab = get().tabs.find(t => t.path === filePath);
    if (!tab) return;

    let content = '';
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        content = await invoke('read_file', { path: filePath });
      } else {
        const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        content = data.content || '';
      }
    } catch (err) {
      console.error('Reload file failed:', err);
      return;
    }

    set({
      tabs: get().tabs.map(t =>
        t.path === filePath
          ? { ...t, content, savedContent: content, dirty: false }
          : t
      ),
    });
  },

  // Reorder tabs by drag (move tab from one index to another)
  reorderTab: (fromIndex, toIndex) => {
    const tabs = [...get().tabs];
    if (fromIndex < 0 || fromIndex >= tabs.length) return;
    if (toIndex < 0 || toIndex >= tabs.length) return;

    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    set({ tabs });
  },

  // Return last 10 opened file paths
  getRecentFiles: () => get().recentFiles,
}));
