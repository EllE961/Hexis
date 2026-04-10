/**
 * Preferences Store — persisted user settings.
 *
 * All values sync to localStorage so they survive reloads.
 * The `onboarded` flag gates the first-launch tutorial.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'hexis-prefs';

const DEFAULTS = {
  onboarded: false,
  theme: 'dark',
  fontSize: 14,
  autoSave: true,
  autoSaveDelay: 2000,
  terminalHeight: 250,
  editorWidth: 750,
};

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveToStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded or private browsing — ignore */ }
}

function getPersistedState() {
  const saved = loadFromStorage();
  return { ...DEFAULTS, ...saved };
}

export const usePrefsStore = create((set, get) => ({
  ...getPersistedState(),

  // Set a single preference and persist
  setPref: (key, value) => {
    set({ [key]: value });
    saveToStorage(get());
  },

  // Batch-set multiple preferences
  setPrefs: (updates) => {
    set(updates);
    saveToStorage(get());
  },

  // Mark onboarding as complete
  completeOnboarding: () => {
    set({ onboarded: true });
    saveToStorage(get());
  },

  // Reset onboarding (for testing / re-showing tutorial)
  resetOnboarding: () => {
    set({ onboarded: false });
    saveToStorage(get());
  },

  // Reset all preferences to defaults
  resetAll: () => {
    set(DEFAULTS);
    saveToStorage(DEFAULTS);
  },
}));
