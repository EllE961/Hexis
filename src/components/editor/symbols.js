/**
 * Lezer-powered symbol extraction and navigation.
 *
 * CodeMirror 6 already parses every open file with Lezer. We walk that
 * existing syntax tree to extract a hierarchical outline of functions,
 * classes, methods, variables, types — and to locate definitions of
 * identifiers under the cursor. No second parser, no new runtime.
 *
 * Per-language node-name mappings live in LANG_MAPS. Each language knows
 * which Lezer node types represent declarations and which child node
 * holds the identifier. Adding a new language = ~10 lines of config.
 */

import { syntaxTree } from '@codemirror/language';

// ─────────────────────────────────────────────────────────────────────
// Language-specific node type maps
// ─────────────────────────────────────────────────────────────────────
//
// Each entry maps Lezer node names → semantic symbol kind, plus the
// child node type that holds the identifier text. `nameChildren` is
// an ordered list; the first match wins.
//
// To add a language: open a file of that language in Hexis, run
// `logTree(view)` from the browser console, and read off the node
// names that correspond to declarations.

const JS_MAP = {
  FunctionDeclaration:  { kind: 'function',  nameChildren: ['VariableDefinition'] },
  FunctionExpression:   { kind: 'function',  nameChildren: ['VariableDefinition'] },
  ClassDeclaration:     { kind: 'class',     nameChildren: ['VariableDefinition'] },
  ClassExpression:      { kind: 'class',     nameChildren: ['VariableDefinition'] },
  MethodDeclaration:    { kind: 'method',    nameChildren: ['PropertyDefinition', 'PrivatePropertyDefinition', 'VariableDefinition'] },
  PropertyDeclaration:  { kind: 'property',  nameChildren: ['PropertyDefinition', 'PrivatePropertyDefinition'] },
  VariableDeclaration:  { kind: 'variable',  nameChildren: ['VariableDefinition'] },
  TypeAliasDeclaration: { kind: 'type',      nameChildren: ['TypeDefinition', 'VariableDefinition'] },
  InterfaceDeclaration: { kind: 'interface', nameChildren: ['TypeDefinition', 'VariableDefinition'] },
  EnumDeclaration:      { kind: 'enum',      nameChildren: ['TypeDefinition', 'VariableDefinition'] },
  NamespaceDeclaration: { kind: 'namespace', nameChildren: ['VariableDefinition'] },
};

const PY_MAP = {
  FunctionDefinition: { kind: 'function', nameChildren: ['VariableName'] },
  ClassDefinition:    { kind: 'class',    nameChildren: ['VariableName'] },
  AssignStatement:    { kind: 'variable', nameChildren: ['VariableName'] },
};

const RUST_MAP = {
  FunctionItem:    { kind: 'function', nameChildren: ['BoundIdentifier', 'Identifier'] },
  StructItem:      { kind: 'struct',   nameChildren: ['TypeIdentifier', 'Identifier'] },
  EnumItem:        { kind: 'enum',     nameChildren: ['TypeIdentifier', 'Identifier'] },
  TraitItem:       { kind: 'interface', nameChildren: ['TypeIdentifier', 'Identifier'] },
  ImplItem:        { kind: 'class',    nameChildren: ['TypeIdentifier', 'Identifier'] },
  TypeItem:        { kind: 'type',     nameChildren: ['TypeIdentifier', 'Identifier'] },
  ModItem:         { kind: 'namespace', nameChildren: ['Identifier'] },
  ConstItem:       { kind: 'constant', nameChildren: ['Identifier'] },
  StaticItem:      { kind: 'constant', nameChildren: ['Identifier'] },
  MacroDefinition: { kind: 'method',   nameChildren: ['Identifier'] },
};

const GO_MAP = {
  FunctionDeclaration: { kind: 'function', nameChildren: ['DefName', 'Identifier'] },
  MethodDeclaration:   { kind: 'method',   nameChildren: ['DefName', 'Identifier'] },
  TypeDeclaration:     { kind: 'type',     nameChildren: ['DefName', 'Identifier'] },
  VarDeclaration:      { kind: 'variable', nameChildren: ['DefName', 'Identifier'] },
  ConstDeclaration:    { kind: 'constant', nameChildren: ['DefName', 'Identifier'] },
};

const CSS_MAP = {
  RuleSet: { kind: 'rule', nameChildren: ['Selector'] },
};

// Languages map to their extraction config by the top-level grammar name
// that Lezer reports in the node tree. We detect language by looking at
// the outermost node name of the tree.
const LANG_MAPS = {
  // JS/TS share most node names
  'JavaScript': JS_MAP,
  'TypeScript': JS_MAP,
  'JSX': JS_MAP,
  'Program': JS_MAP, // @lezer/javascript uses "Program" as the root
  'Script':  JS_MAP,

  // Python
  'Python':  PY_MAP,

  // Rust
  'Rust':    RUST_MAP,
  'SourceFile': RUST_MAP,

  // Go
  'Go':      GO_MAP,

  // CSS
  'StyleSheet': CSS_MAP,
};

// ─────────────────────────────────────────────────────────────────────
// Symbol kind → display icon + color (for outline panel + breadcrumbs)
// ─────────────────────────────────────────────────────────────────────

export const SYMBOL_STYLE = {
  function:  { icon: 'ƒ',  color: '#F0A030', label: 'function' },
  method:    { icon: 'ƒ',  color: '#58A6FF', label: 'method' },
  class:     { icon: '◆',  color: '#D2A8FF', label: 'class' },
  interface: { icon: '◇',  color: '#A5D6FF', label: 'interface' },
  type:      { icon: 'T',  color: '#79C0FF', label: 'type' },
  enum:      { icon: '≡',  color: '#FFA657', label: 'enum' },
  struct:    { icon: '▣',  color: '#FFA657', label: 'struct' },
  property:  { icon: '•',  color: '#8B949E', label: 'property' },
  variable:  { icon: 'v',  color: '#7EE787', label: 'variable' },
  constant:  { icon: 'K',  color: '#FFAB70', label: 'const' },
  namespace: { icon: '{}', color: '#D2A8FF', label: 'namespace' },
  rule:      { icon: '§',  color: '#56D4DD', label: 'rule' },
};

// ─────────────────────────────────────────────────────────────────────
// Pick the right map for a given file based on the syntax tree root
// ─────────────────────────────────────────────────────────────────────

function pickMap(tree) {
  if (!tree) return null;
  const rootName = tree.type.name;
  return LANG_MAPS[rootName] || null;
}

// ─────────────────────────────────────────────────────────────────────
// Extract the name child from a declaration node
// ─────────────────────────────────────────────────────────────────────

function findNameChild(node, nameChildren) {
  // Walk direct children looking for the first matching nameChild type.
  // Falls back to scanning grandchildren for languages (like JS) where
  // the identifier is nested inside a pattern or type annotation.
  for (const name of nameChildren) {
    const child = node.getChild(name);
    if (child) return child;
  }
  // Deep fallback: find the first descendant with a matching type.
  let found = null;
  node.cursor().iterate((c) => {
    if (found) return false;
    if (nameChildren.includes(c.type.name)) {
      found = c.node;
      return false;
    }
  });
  return found;
}

// ─────────────────────────────────────────────────────────────────────
// Build a hierarchical outline from the current editor state
// ─────────────────────────────────────────────────────────────────────

/**
 * @returns {Array} hierarchical list of outline items
 *   { kind, name, from, to, nameFrom, nameTo, children }
 */
export function buildOutline(state) {
  const tree = syntaxTree(state);
  const map = pickMap(tree);
  if (!map) return [];

  const root = { kind: 'root', name: '', from: 0, to: state.doc.length, nameFrom: 0, nameTo: 0, children: [] };
  const stack = [root];

  tree.iterate({
    enter: (nodeRef) => {
      const typeName = nodeRef.type.name;
      const entry = map[typeName];
      if (!entry) return;

      const nameNode = findNameChild(nodeRef.node, entry.nameChildren);
      if (!nameNode) return;

      const name = state.sliceDoc(nameNode.from, nameNode.to);
      if (!name || name.length === 0) return;

      const item = {
        kind: entry.kind,
        name,
        from: nodeRef.from,
        to: nodeRef.to,
        nameFrom: nameNode.from,
        nameTo: nameNode.to,
        children: [],
      };

      // Parent = current top of stack (innermost enclosing symbol)
      stack[stack.length - 1].children.push(item);
      stack.push(item);
    },
    leave: (nodeRef) => {
      // Pop if this node opened the current top-of-stack entry
      const top = stack[stack.length - 1];
      if (top !== root && top.from === nodeRef.from && top.to === nodeRef.to) {
        stack.pop();
      }
    },
  });

  return root.children;
}

// ─────────────────────────────────────────────────────────────────────
// Find the breadcrumb chain at a cursor position
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns an array of outline items from outermost → innermost that
 * enclose the given cursor position. Powers the breadcrumb bar and
 * the sticky-scroll header.
 */
export function breadcrumbChainAt(state, pos) {
  const outline = buildOutline(state);
  const chain = [];

  function walk(items) {
    for (const item of items) {
      if (pos >= item.from && pos <= item.to) {
        chain.push(item);
        walk(item.children);
        return;
      }
    }
  }
  walk(outline);
  return chain;
}

// ─────────────────────────────────────────────────────────────────────
// Identifier detection — is position `pos` on an identifier node?
// ─────────────────────────────────────────────────────────────────────

const IDENTIFIER_NODE_NAMES = new Set([
  // JS/TS
  'VariableName', 'VariableDefinition', 'PropertyName', 'PropertyDefinition',
  'TypeName', 'TypeDefinition', 'PrivatePropertyName', 'PrivatePropertyDefinition',
  // Python
  'VariableName', 'PropertyName',
  // Rust
  'Identifier', 'BoundIdentifier', 'TypeIdentifier', 'FieldIdentifier',
  // Go
  'DefName', 'Identifier',
]);

export function identifierAt(state, pos) {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);
  if (!node || !IDENTIFIER_NODE_NAMES.has(node.name)) return null;
  return {
    name: state.sliceDoc(node.from, node.to),
    from: node.from,
    to: node.to,
    typeName: node.name,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Same-file go-to-definition with scope walking
// ─────────────────────────────────────────────────────────────────────

// Node types that define a lexical scope. For same-file go-to-def we
// walk UP from the reference to find enclosing scopes, then at each
// level look for a definition with the matching name BEFORE descending
// further. This approximates scope resolution in ~30 lines.
const SCOPE_NODE_NAMES = new Set([
  // JS/TS
  'Block', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction',
  'MethodDeclaration', 'ClassDeclaration', 'ClassBody', 'Program', 'Script',
  // Python
  'FunctionDefinition', 'ClassDefinition', 'Body',
  // Rust
  'Block', 'FunctionItem', 'ImplItem', 'ModItem', 'SourceFile',
  // Go
  'Block', 'FunctionDeclaration', 'MethodDeclaration',
]);

const DEFINITION_NODE_NAMES = new Set([
  'VariableDefinition', 'PropertyDefinition', 'PrivatePropertyDefinition',
  'TypeDefinition', 'BoundIdentifier', 'TypeIdentifier', 'FieldIdentifier',
  'DefName',
]);

/**
 * Find the nearest definition of the identifier named `name`, starting
 * from position `fromPos` and searching outward through enclosing
 * scopes. Returns { from, to } of the definition site, or null.
 */
export function findDefinitionInFile(state, name, fromPos) {
  if (!name) return null;
  const tree = syntaxTree(state);
  let node = tree.resolveInner(fromPos, -1);

  // Walk up through enclosing scopes
  while (node) {
    const isScope = SCOPE_NODE_NAMES.has(node.name);
    if (isScope || !node.parent) {
      // Search this scope's subtree for a matching definition
      const hit = findDefinitionInSubtree(state, node, name);
      if (hit) return hit;
    }
    node = node.parent;
  }

  // Last-resort: search the whole document tree
  return findDefinitionInSubtree(state, tree.topNode, name);
}

function findDefinitionInSubtree(state, rootNode, name) {
  let best = null;
  const cursor = rootNode.cursor();
  cursor.iterate(
    (nodeRef) => {
      if (DEFINITION_NODE_NAMES.has(nodeRef.type.name)) {
        const text = state.sliceDoc(nodeRef.from, nodeRef.to);
        if (text === name) {
          best = { from: nodeRef.from, to: nodeRef.to };
          return false;
        }
      }
    },
  );
  return best;
}

// ─────────────────────────────────────────────────────────────────────
// Workspace identifier harvest (for autocomplete source)
// ─────────────────────────────────────────────────────────────────────

/**
 * Find all occurrences of an identifier name in the file. Returns an
 * array of {from, to} ranges, sorted by position. Used to power F2
 * rename-in-file without semantic analysis — the simplest implementation
 * renames every lexical occurrence of the name, which is correct for
 * locally-scoped symbols and "mostly right" for others. A full
 * scope-aware rename is LSP territory.
 */
export function findAllOccurrences(state, name) {
  if (!name) return [];
  const tree = syntaxTree(state);
  const ranges = [];
  tree.iterate({
    enter: (nodeRef) => {
      if (IDENTIFIER_NODE_NAMES.has(nodeRef.type.name)) {
        const text = state.sliceDoc(nodeRef.from, nodeRef.to);
        if (text === name) {
          ranges.push({ from: nodeRef.from, to: nodeRef.to });
        }
      }
    },
  });
  return ranges;
}

/**
 * Scan the current document for all unique identifier nodes — used as
 * a dumb but effective autocomplete fallback. Returns a Set of strings.
 */
export function harvestIdentifiers(state) {
  const result = new Set();
  const tree = syntaxTree(state);
  tree.iterate({
    enter: (nodeRef) => {
      if (IDENTIFIER_NODE_NAMES.has(nodeRef.type.name)) {
        const text = state.sliceDoc(nodeRef.from, nodeRef.to);
        if (text && text.length >= 2 && /^[A-Za-z_$][\w$]*$/.test(text)) {
          result.add(text);
        }
      }
    },
  });
  return result;
}
