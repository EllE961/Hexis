/**
 * CodeMirror 6 extensions for Hexis power features.
 *
 * Everything in this file is wired into every editor view regardless of
 * language. Language-specific node names live in ./symbols.js.
 *
 * Exports:
 *   - stickyScroll       — pinned header showing enclosing class/function
 *   - goToDefinitionKeymap — F12 + Ctrl/Cmd-click jump to definition
 *   - smartSelectionKeymap — Alt+ArrowUp/Down syntax-aware selection grow
 *   - localAutocomplete  — workspace identifier completion source
 *   - indentGuides       — vertical lines at each indent level
 *   - bracketColorization — rainbow matched bracket pairs
 *   - cursorReporter     — calls `onCursor(pos)` whenever the main selection moves
 *   - outlineReporter    — calls `onOutline(items)` whenever the doc/outline changes
 */

import { EditorView, ViewPlugin, Decoration, WidgetType, keymap, showTooltip } from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import { selectParentSyntax } from '@codemirror/commands';
import {
  buildOutline,
  breadcrumbChainAt,
  identifierAt,
  findDefinitionInFile,
  findAllOccurrences,
  harvestIdentifiers,
  SYMBOL_STYLE,
} from './symbols.js';

// ═════════════════════════════════════════════════════════════════════
// 1. STICKY SCROLL
// ═════════════════════════════════════════════════════════════════════
//
// Reads the outline, finds the symbols enclosing the viewport's first
// visible line, and renders them as a fixed overlay header pinned to
// the top of the scroll container. Users always see "which class /
// method am I looking at?" — VS Code's most-praised feature of 2024.

const stickyScrollPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.container = document.createElement('div');
      this.container.className = 'cm-hexis-sticky';
      this.container.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 4;
        pointer-events: none;
        background: rgba(13, 17, 23, 0.92);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid rgba(240, 160, 48, 0.18);
        font-family: "JetBrains Mono", monospace;
        font-size: 12px;
        color: #8B949E;
      `;
      view.scrollDOM.parentElement?.appendChild(this.container);
      this.update();
    }

    update(update) {
      if (update && !update.docChanged && !update.viewportChanged && !update.geometryChanged) return;
      try {
        const vp = this.view.viewport;
        const topLineBlock = this.view.lineBlockAt(vp.from);
        const firstVisiblePos = topLineBlock.from;
        const chain = breadcrumbChainAt(this.view.state, firstVisiblePos);

        // Trim: only show symbols whose header ISN'T visible already.
        // If the first visible line IS the symbol's first line, we don't
        // need to pin it because it's already on screen.
        const pinned = chain.filter((item) => {
          const block = this.view.lineBlockAt(item.from);
          return block.from < firstVisiblePos;
        });

        if (pinned.length === 0) {
          this.container.innerHTML = '';
          this.container.style.display = 'none';
          return;
        }

        this.container.style.display = 'block';
        this.container.innerHTML = pinned
          .map((item, i) => {
            const style = SYMBOL_STYLE[item.kind] || SYMBOL_STYLE.variable;
            const indent = i * 16;
            return `
              <div style="
                padding: 3px 12px 3px ${12 + indent}px;
                display: flex;
                align-items: center;
                gap: 8px;
                border-top: ${i === 0 ? 'none' : '1px solid rgba(139,148,158,0.06)'};
              ">
                <span style="color: ${style.color}; font-weight: 700; width: 12px; text-align: center;">${style.icon}</span>
                <span style="color: #E6EDF3; font-weight: 500;">${escapeHtml(item.name)}</span>
                <span style="color: #484F58; font-size: 10px; margin-left: auto;">${style.label}</span>
              </div>
            `;
          })
          .join('');
      } catch {
        // Outline may fail on unsupported languages — stay invisible
        this.container.innerHTML = '';
        this.container.style.display = 'none';
      }
    }

    destroy() {
      this.container.remove();
    }
  }
);

export const stickyScroll = stickyScrollPlugin;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ═════════════════════════════════════════════════════════════════════
// 2. GO-TO-DEFINITION (F12 + Ctrl/Cmd-click)
// ═════════════════════════════════════════════════════════════════════

function jumpToDefinitionAt(view, pos) {
  const state = view.state;
  const ident = identifierAt(state, pos);
  if (!ident) return false;

  const hit = findDefinitionInFile(state, ident.name, pos);
  if (!hit || (hit.from === ident.from && hit.to === ident.to)) return false;

  view.dispatch({
    selection: { anchor: hit.from, head: hit.to },
    effects: EditorView.scrollIntoView(hit.from, { y: 'center' }),
  });
  return true;
}

// F12 command
function goToDefinition(view) {
  const pos = view.state.selection.main.head;
  return jumpToDefinitionAt(view, pos);
}

// Ctrl/Cmd+click handler — intercepts mousedown while modifier is held
const clickToJumpHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.ctrlKey || event.metaKey)) return false;
    if (event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    if (jumpToDefinitionAt(view, pos)) {
      event.preventDefault();
      return true;
    }
    return false;
  },
});

// Visual underline on identifier while Ctrl/Cmd held
const underlineMark = Decoration.mark({
  class: 'cm-hexis-link',
  attributes: { style: 'text-decoration: underline; text-decoration-color: #58A6FF; cursor: pointer;' },
});

const underlineModifierField = StateField.define({
  create: () => Decoration.none,
  update: (deco, tr) => {
    for (const e of tr.effects) {
      if (e.is(setUnderlineRange)) {
        if (!e.value) return Decoration.none;
        return Decoration.set([underlineMark.range(e.value.from, e.value.to)]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setUnderlineRange = StateEffect.define();

const hoverUnderlinePlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.lastRange = null;
      this._move = (e) => this.onMove(e);
      this._keyup = () => this.clear();
      this._leave = () => this.clear();
      view.dom.addEventListener('mousemove', this._move);
      window.addEventListener('keyup', this._keyup);
      view.dom.addEventListener('mouseleave', this._leave);
    }
    onMove(e) {
      if (!(e.ctrlKey || e.metaKey)) { this.clear(); return; }
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) { this.clear(); return; }
      const ident = identifierAt(this.view.state, pos);
      if (!ident) { this.clear(); return; }
      const key = `${ident.from}:${ident.to}`;
      if (this.lastRange === key) return;
      this.lastRange = key;
      this.view.dispatch({ effects: setUnderlineRange.of({ from: ident.from, to: ident.to }) });
    }
    clear() {
      if (this.lastRange == null) return;
      this.lastRange = null;
      this.view.dispatch({ effects: setUnderlineRange.of(null) });
    }
    destroy() {
      this.view.dom.removeEventListener('mousemove', this._move);
      window.removeEventListener('keyup', this._keyup);
      this.view.dom.removeEventListener('mouseleave', this._leave);
    }
  }
);

// ═════════════════════════════════════════════════════════════════════
// PEEK DEFINITION (Alt+F12 / Ctrl+Shift+F10)
// ═════════════════════════════════════════════════════════════════════
//
// Shows the definition as an inline tooltip above the current cursor
// position, without moving the cursor. Uses CM6's showTooltip state
// field. Pressing Escape or moving the cursor dismisses the peek.

const peekTooltipEffect = StateEffect.define(); // value: tooltip | null

const peekTooltipField = StateField.define({
  create: () => null,
  update: (tooltip, tr) => {
    for (const e of tr.effects) {
      if (e.is(peekTooltipEffect)) return e.value;
    }
    // Dismiss on any selection move
    if (tr.selection && tooltip) return null;
    return tooltip;
  },
  provide: (f) => showTooltip.from(f),
});

function peekDefinition(view) {
  const pos = view.state.selection.main.head;
  const ident = identifierAt(view.state, pos);
  if (!ident) return false;
  const hit = findDefinitionInFile(view.state, ident.name, pos);
  if (!hit) return false;

  // Gather 5 lines of context around the definition
  const defLine = view.state.doc.lineAt(hit.from);
  const startLine = Math.max(1, defLine.number - 1);
  const endLine = Math.min(view.state.doc.lines, defLine.number + 4);
  const snippet = [];
  for (let i = startLine; i <= endLine; i++) {
    const line = view.state.doc.line(i);
    snippet.push({ num: i, text: line.text, isDef: i === defLine.number });
  }

  view.dispatch({
    effects: peekTooltipEffect.of({
      pos,
      above: true,
      strictSide: false,
      arrow: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-hexis-peek';
        dom.style.cssText = `
          background: #0D1117;
          border: 1px solid rgba(240, 160, 48, 0.4);
          border-radius: 6px;
          padding: 8px 0;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5);
          font-family: "JetBrains Mono", monospace;
          font-size: 12px;
          max-width: 600px;
          overflow: hidden;
        `;
        const header = document.createElement('div');
        header.style.cssText = `
          padding: 0 12px 6px;
          color: #8B949E;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(139,148,158,0.1);
          margin-bottom: 6px;
        `;
        header.innerHTML = `<span>Peek: <span style="color:#F0A030;">${escapeHtml(ident.name)}</span></span><span style="color:#484F58;">Esc to close</span>`;
        dom.appendChild(header);

        for (const line of snippet) {
          const row = document.createElement('div');
          row.style.cssText = `
            display: flex;
            padding: 1px 12px;
            white-space: pre;
            ${line.isDef ? 'background: rgba(240, 160, 48, 0.08); border-left: 2px solid #F0A030; margin-left: -2px;' : ''}
          `;
          const lineNum = document.createElement('span');
          lineNum.style.cssText = 'color: #484F58; width: 40px; text-align: right; margin-right: 12px; flex-shrink: 0;';
          lineNum.textContent = String(line.num);
          const text = document.createElement('span');
          text.style.cssText = `color: ${line.isDef ? '#E6EDF3' : '#8B949E'}; flex: 1;`;
          text.textContent = line.text || ' ';
          row.appendChild(lineNum);
          row.appendChild(text);
          dom.appendChild(row);
        }

        const footer = document.createElement('div');
        footer.style.cssText = 'padding: 6px 12px 0; border-top: 1px solid rgba(139,148,158,0.1); margin-top: 6px; color: #484F58; font-size: 10px; display: flex; justify-content: space-between;';
        footer.innerHTML = `<span>F12 to jump</span><span>Line ${defLine.number}</span>`;
        dom.appendChild(footer);

        return { dom, offset: { x: 0, y: -8 } };
      },
    }),
  });
  return true;
}

function dismissPeek(view) {
  if (view.state.field(peekTooltipField, false)) {
    view.dispatch({ effects: peekTooltipEffect.of(null) });
    return true;
  }
  return false;
}

export const peekDefinitionExt = [
  peekTooltipField,
  keymap.of([
    { key: 'Alt-F12', run: peekDefinition },
    { key: 'Ctrl-Shift-F10', run: peekDefinition },
    { key: 'Escape', run: dismissPeek },
  ]),
];

// F2: rename all occurrences of the identifier under cursor.
// Opens a small inline prompt via a prompt-style DOM overlay, then
// applies a single CM transaction that replaces all ranges atomically.
function renameInFile(view) {
  const pos = view.state.selection.main.head;
  const ident = identifierAt(view.state, pos);
  if (!ident) return false;

  // Simple prompt-based rename. A nicer inline UI would be better,
  // but prompt() is zero-UI-code and works today.
  const newName = window.prompt(`Rename "${ident.name}" to:`, ident.name);
  if (!newName || newName === ident.name) return true; // cancelled
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) {
    window.alert('Invalid identifier name.');
    return true;
  }

  const ranges = findAllOccurrences(view.state, ident.name);
  if (ranges.length === 0) return false;

  // Build a single transaction with all replacements
  view.dispatch({
    changes: ranges.map((r) => ({ from: r.from, to: r.to, insert: newName })),
  });
  return true;
}

export const goToDefinitionKeymap = [
  keymap.of([
    { key: 'F12', run: goToDefinition },
    { key: 'Mod-F12', run: goToDefinition },
    { key: 'F2', run: renameInFile },
  ]),
  clickToJumpHandler,
  underlineModifierField,
  hoverUnderlinePlugin,
];

// ═════════════════════════════════════════════════════════════════════
// 3. SMART SELECTION EXPANSION (Alt+Up / Alt+Down)
// ═════════════════════════════════════════════════════════════════════
//
// Alt+Up grows selection to parent syntax node. Alt+Down shrinks back
// through history. Uses CM6's built-in selectParentSyntax + a ring
// buffer for shrink.

const selectionHistoryField = StateField.define({
  create: () => [],
  update: (history, tr) => {
    // Only track after a grow command
    if (tr.isUserEvent('select.syntax.grow')) {
      const main = tr.startState.selection.main;
      return [...history, { from: main.from, to: main.to }];
    }
    // Any other user-driven selection change clears history
    if (tr.selection && !tr.isUserEvent('select.syntax.shrink')) {
      return [];
    }
    return history;
  },
});

function growSelection(view) {
  view.dispatch({ userEvent: 'select.syntax.grow' });
  return selectParentSyntax(view);
}

function shrinkSelection(view) {
  const history = view.state.field(selectionHistoryField);
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  view.dispatch({
    selection: { anchor: last.from, head: last.to },
    effects: [],
    userEvent: 'select.syntax.shrink',
    // pop the ring
  });
  return true;
}

export const smartSelectionKeymap = [
  selectionHistoryField,
  keymap.of([
    { key: 'Alt-ArrowUp', run: growSelection },
    { key: 'Alt-ArrowDown', run: shrinkSelection },
  ]),
];

// ═════════════════════════════════════════════════════════════════════
// 4. LOCAL AUTOCOMPLETE (workspace-identifier source)
// ═════════════════════════════════════════════════════════════════════
//
// Scans all identifier-ish tokens in the current document and offers
// them as completions. Fast, free, and dramatically better than nothing.
// LSP will slot in as a second source in Phase 3.

function localCompletionSource(context) {
  const word = context.matchBefore(/[A-Za-z_$][\w$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const prefix = word.text;
  const identifiers = harvestIdentifiers(context.state);
  const options = [];

  for (const ident of identifiers) {
    if (ident === prefix) continue;
    if (prefix && !ident.toLowerCase().startsWith(prefix.toLowerCase())) {
      // Also allow fuzzy subsequence
      if (!fuzzyMatch(prefix.toLowerCase(), ident.toLowerCase())) continue;
    }
    options.push({
      label: ident,
      type: 'variable',
      boost: ident.startsWith(prefix) ? 1 : 0,
    });
  }

  return { from: word.from, options, validFor: /^[A-Za-z_$][\w$]*$/ };
}

function fuzzyMatch(needle, haystack) {
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j === needle.length;
}

export const localAutocomplete = autocompletion({
  override: [localCompletionSource],
  closeOnBlur: true,
  activateOnTyping: true,
  maxRenderedOptions: 24,
});

// ═════════════════════════════════════════════════════════════════════
// 5. INDENT GUIDES
// ═════════════════════════════════════════════════════════════════════
//
// Renders vertical ghost lines at each indent level. Highlights the
// guide matching the enclosing scope of the cursor.

const indentGuideField = StateField.define({
  create: (state) => buildIndentGuides(state),
  update: (deco, tr) => {
    if (!tr.docChanged && !tr.selection) return deco;
    return buildIndentGuides(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildIndentGuides(state) {
  const builder = new RangeSetBuilder();
  const tabSize = state.tabSize || 2;
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.length === 0) continue;
    const leading = line.text.match(/^[ \t]*/)[0];
    let indent = 0;
    for (const ch of leading) indent += ch === '\t' ? tabSize : 1;
    const levels = Math.floor(indent / tabSize);
    if (levels === 0) continue;
    // Determine "active" guide: matches the cursor's indent level
    const cursorActive = i === cursorLine;
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: cursorActive ? 'cm-hexis-indent cm-hexis-indent-active' : 'cm-hexis-indent',
        attributes: { 'data-indent': String(levels) },
      }),
    );
  }
  return builder.finish();
}

// Static style for the indent guides — injected as theme
export const indentGuides = [
  indentGuideField,
  EditorView.theme({
    '.cm-hexis-indent': {
      backgroundImage:
        'linear-gradient(to right, rgba(139, 148, 158, 0.18) 1px, transparent 1px)',
      backgroundSize: 'calc(1ch * var(--hexis-indent, 2)) 100%',
      backgroundRepeat: 'repeat-x',
      backgroundPosition: '12px 0',
    },
    '.cm-hexis-indent-active': {
      backgroundImage:
        'linear-gradient(to right, rgba(240, 160, 48, 0.45) 1px, transparent 1px)',
    },
  }),
];

// ═════════════════════════════════════════════════════════════════════
// 6. BRACKET PAIR COLORIZATION
// ═════════════════════════════════════════════════════════════════════
//
// Walks the syntax tree and marks matched bracket pairs with rainbow
// colors by nesting depth. Five colors cycle.

const BRACKET_COLORS = ['#F0A030', '#58A6FF', '#7EE787', '#D2A8FF', '#FFA657'];

const bracketColorField = StateField.define({
  create: (state) => buildBracketColors(state),
  update: (deco, tr) => {
    if (!tr.docChanged) return deco.map(tr.changes);
    return buildBracketColors(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildBracketColors(state) {
  const builder = new RangeSetBuilder();
  const tree = syntaxTree(state);
  const stack = [];

  // Add decorations sorted by start position.
  // We collect then sort then add, because tree iteration isn't
  // strictly in document order for all grammars.
  const marks = [];

  tree.iterate({
    enter: (nodeRef) => {
      const name = nodeRef.type.name;
      // Lezer grammars expose bracket nodes with names like
      // "{", "}", "(", ")", "[", "]"
      if (name === '{' || name === '(' || name === '[') {
        stack.push({ name, from: nodeRef.from, to: nodeRef.to });
      } else if (name === '}' || name === ')' || name === ']') {
        const match = stack.pop();
        if (match) {
          const depth = stack.length;
          const color = BRACKET_COLORS[depth % BRACKET_COLORS.length];
          marks.push({ from: match.from, to: match.to, color });
          marks.push({ from: nodeRef.from, to: nodeRef.to, color });
        }
      }
    },
  });

  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const m of marks) {
    builder.add(
      m.from,
      m.to,
      Decoration.mark({
        attributes: { style: `color: ${m.color}; font-weight: 700;` },
      }),
    );
  }
  return builder.finish();
}

export const bracketColorization = bracketColorField;

// ═════════════════════════════════════════════════════════════════════
// 7. CURSOR & OUTLINE REPORTERS
// ═════════════════════════════════════════════════════════════════════
//
// Bridges CM6 state to React. Calls the provided callbacks whenever
// the outline (on doc change) or the cursor breadcrumb chain (on
// selection change) needs to update.

export function cursorReporter(onCursor) {
  return EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged) {
      const pos = u.state.selection.main.head;
      try {
        const chain = breadcrumbChainAt(u.state, pos);
        onCursor(pos, chain);
      } catch {
        onCursor(pos, []);
      }
    }
  });
}

export function outlineReporter(onOutline) {
  let scheduled = false;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged && !(u.transactions.length > 0 && u.state.doc.length !== u.startState.doc.length)) return;
    // Debounce — outline computation is O(n) over tree, only needed
    // a few times per second at most during rapid typing.
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        onOutline(buildOutline(u.view.state));
      } catch {
        onOutline([]);
      }
    }, 250);
  });
}

// Initial outline — call once after mount to populate.
export function initialOutline(state) {
  try {
    return buildOutline(state);
  } catch {
    return [];
  }
}
