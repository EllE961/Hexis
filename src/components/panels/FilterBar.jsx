import { useMemo, useState } from 'react';
import { useGraphStore, isNodeVisible } from '../../hooks/useGraph.js';
import { colors, statusColor } from '../../theme/tokens.js';
import { getSectionColor } from '../../utils/colors.js';
import {
  X, Clock, Link2, ShieldCheck, ChevronDown,
  FileType, Activity, Eye, Filter, EyeOff, Waypoints,
} from 'lucide-react';

function Pill({ active, color, onClick, count, children }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-fast"
      style={{
        background: active ? `${color}18` : 'rgba(180,140,60,0.02)',
        border: `1px solid ${active ? `${color}35` : 'rgba(180,140,60,0.04)'}`,
        color: active ? color : colors.textTertiary,
      }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(180,140,60,0.05)'; e.currentTarget.style.color = colors.textSecondary; } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'rgba(180,140,60,0.02)'; e.currentTarget.style.color = colors.textTertiary; } }}
    >
      {children}
      {count != null && (
        <span className="text-[9px] px-1 py-0 rounded-full" style={{
          background: active ? `${color}20` : 'rgba(180,140,60,0.06)',
          color: active ? color : colors.textTertiary,
          minWidth: 14, textAlign: 'center',
        }}>{count}</span>
      )}
    </button>
  );
}

function FilterDropdown({ label, icon, children, open, onToggle }) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-fast"
        style={{
          background: open ? 'rgba(232,146,12,0.1)' : 'rgba(180,140,60,0.02)',
          border: `1px solid ${open ? 'rgba(232,146,12,0.2)' : 'rgba(180,140,60,0.04)'}`,
          color: open ? colors.accent : colors.textTertiary,
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = 'rgba(180,140,60,0.05)'; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'rgba(180,140,60,0.02)'; }}
      >
        {icon} {label} <ChevronDown size={10} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: '150ms ease' }} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 rounded-xl overflow-hidden py-2 min-w-[180px]"
          style={{ background: colors.bgBase, border: `1px solid ${colors.borderHover}`, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', zIndex: 100 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownItem({ active, color, onClick, label, count }) {
  return (
    <button onClick={onClick}
      className="w-full text-left px-4 py-2 text-[12px] flex items-center justify-between transition-fast"
      style={{ background: active ? `${color || colors.accent}10` : 'transparent', color: active ? (color || colors.accent) : colors.textSecondary }}
      onMouseEnter={e => e.currentTarget.style.background = active ? `${color || colors.accent}15` : 'rgba(180,140,60,0.04)'}
      onMouseLeave={e => e.currentTarget.style.background = active ? `${color || colors.accent}10` : 'transparent'}
    >
      <span className="flex items-center gap-2">
        {color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />}
        {label}
      </span>
      {count != null && <span className="text-[10px]" style={{ color: colors.textTertiary }}>{count}</span>}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-4" style={{ background: 'rgba(180,140,60,0.06)' }} />;
}

export default function FilterBar() {
  const nodes = useGraphStore(s => s.nodes);
  const filters = useGraphStore(s => s.filters);
  const gitStatus = useGraphStore(s => s.gitStatus);
  const showChanges = useGraphStore(s => s.showChanges);
  const showEdges = useGraphStore(s => s.showEdges);
  const toggleFilter = useGraphStore(s => s.toggleFilter);
  const clearFilters = useGraphStore(s => s.clearFilters);
  const toggleShowChanges = useGraphStore(s => s.toggleShowChanges);
  const toggleShowEdges = useGraphStore(s => s.toggleShowEdges);

  const [expanded, setExpanded] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null);

  const hasActiveFilters = filters.sections.length > 0 || filters.types.length > 0 ||
    filters.statuses.length > 0 || filters.recency || filters.connections || filters.health;

  const available = useMemo(() => {
    const sections = new Set(), types = new Set(), statuses = new Set();
    for (const n of nodes) { sections.add(n.section); types.add(n.type); statuses.add(n.status); }
    return { sections: [...sections].sort(), types: [...types].sort(), statuses: [...statuses].sort() };
  }, [nodes]);

  const counts = useMemo(() => {
    const c = { sections: {}, types: {}, statuses: {} };
    for (const n of nodes) { c.sections[n.section] = (c.sections[n.section] || 0) + 1; c.types[n.type] = (c.types[n.type] || 0) + 1; c.statuses[n.status] = (c.statuses[n.status] || 0) + 1; }
    return c;
  }, [nodes]);

  const visibleCount = useMemo(() => nodes.filter(n => isNodeVisible(n, filters)).length, [nodes, filters]);
  const changedCount = gitStatus ? (gitStatus.modified?.length || 0) + (gitStatus.not_added?.length || 0) : 0;

  if (nodes.length === 0) return null;

  // Click-away for dropdowns
  const closeDropdowns = () => setOpenDropdown(null);

  // ═══ Collapsed state: just a small button ═══
  if (!expanded) {
    return (
      <button
        className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 py-2 rounded-xl transition-fast"
        style={{
          background: 'rgba(14, 14, 20, 0.9)',
          backdropFilter: 'blur(16px)',
          border: `1px solid ${hasActiveFilters ? 'rgba(99, 102, 241, 0.25)' : 'rgba(180,140,60,0.06)'}`,
          boxShadow: '0 4px 20px rgba(120,80,20,0.1)',
          color: hasActiveFilters ? colors.accent : colors.textTertiary,
        }}
        onClick={() => setExpanded(true)}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(14, 14, 20, 0.95)'}
        onMouseLeave={e => e.currentTarget.style.background = 'rgba(14, 14, 20, 0.9)'}
      >
        <Filter size={13} />
        <span className="text-[12px] font-medium">
          {hasActiveFilters ? `Filters (${visibleCount}/${nodes.length})` : 'Filters'}
        </span>
        {hasActiveFilters && (
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: colors.accent }} />
        )}
      </button>
    );
  }

  // ═══ Expanded state ═══
  return (
    <>
      {openDropdown && <div className="fixed inset-0 z-20" onClick={closeDropdowns} />}

      <div
        className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 px-2.5 py-1.5 rounded-xl"
        style={{
          background: 'rgba(14, 14, 20, 0.92)',
          backdropFilter: 'blur(20px)',
          border: `1px solid ${hasActiveFilters ? 'rgba(99, 102, 241, 0.25)' : 'rgba(180,140,60,0.06)'}`,
          boxShadow: '0 4px 30px rgba(120,80,20,0.15), 0 0 1px rgba(180,140,60,0.05) inset',
          maxWidth: '96vw',
        }}
      >
        {/* Match count + close */}
        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px]" style={{ color: hasActiveFilters ? colors.accent : colors.textTertiary }}>
          <Filter size={12} />
          {hasActiveFilters && <span className="font-medium">{visibleCount}/{nodes.length}</span>}
        </div>

        <Sep />

        {/* Sections */}
        {available.sections.map(section => (
          <Pill key={section} active={filters.sections.includes(section)} color={getSectionColor(section)}
            count={counts.sections[section]} onClick={() => toggleFilter('sections', section)}>
            <span className="capitalize">{section === '.' ? 'root' : section}</span>
          </Pill>
        ))}

        <Sep />

        {/* Type dropdown */}
        <FilterDropdown label={`Type${filters.types.length > 0 ? ` (${filters.types.length})` : ''}`}
          icon={<FileType size={11} />} open={openDropdown === 'types'} onToggle={() => setOpenDropdown(openDropdown === 'types' ? null : 'types')}>
          {available.types.map(type => (
            <DropdownItem key={type} active={filters.types.includes(type)} onClick={() => toggleFilter('types', type)} label={type} count={counts.types[type]} />
          ))}
        </FilterDropdown>

        {/* Status dropdown */}
        <FilterDropdown label={`Status${filters.statuses.length > 0 ? ` (${filters.statuses.length})` : ''}`}
          icon={<Activity size={11} />} open={openDropdown === 'statuses'} onToggle={() => setOpenDropdown(openDropdown === 'statuses' ? null : 'statuses')}>
          {available.statuses.map(status => (
            <DropdownItem key={status} active={filters.statuses.includes(status)} color={statusColor[status]}
              onClick={() => toggleFilter('statuses', status)} label={status} count={counts.statuses[status]} />
          ))}
        </FilterDropdown>

        <Sep />

        {/* Quick filters */}
        <Pill active={filters.recency === 'week'} color="#22C55E" onClick={() => toggleFilter('recency', 'week')}><Clock size={10} /> 7d</Pill>
        <Pill active={filters.recency === 'month'} color="#22C55E" onClick={() => toggleFilter('recency', 'month')}><Clock size={10} /> 30d</Pill>
        <Pill active={filters.recency === 'stale'} color="#EF4444" onClick={() => toggleFilter('recency', 'stale')}><Clock size={10} /> Stale</Pill>

        <Sep />

        <Pill active={filters.connections === 'orphan'} color="#EAB308" onClick={() => toggleFilter('connections', 'orphan')}><Link2 size={10} /> Orphan</Pill>
        <Pill active={filters.connections === 'hub'} color="#8B5CF6" onClick={() => toggleFilter('connections', 'hub')}><Link2 size={10} /> Hub</Pill>
        <Pill active={filters.health === 'unhealthy'} color="#EF4444" onClick={() => toggleFilter('health', 'unhealthy')}><ShieldCheck size={10} /> Issues</Pill>

        <Sep />

        {/* Toggle edges */}
        <Pill active={showEdges !== false} color={colors.textSecondary} onClick={toggleShowEdges}>
          <Waypoints size={10} /> Edges
        </Pill>

        {/* Toggle changes */}
        <Pill active={showChanges} color="#F0A030" onClick={toggleShowChanges} count={changedCount > 0 ? changedCount : null}>
          <Eye size={10} /> Changes
        </Pill>

        {/* Clear + close */}
        {hasActiveFilters && (
          <>
            <Sep />
            <button onClick={clearFilters}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-fast"
              style={{ color: '#EF4444', background: 'rgba(239, 68, 68, 0.08)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'}>
              <X size={11} /> Clear
            </button>
          </>
        )}

        <Sep />

        {/* Close button */}
        <button onClick={() => { setExpanded(false); closeDropdowns(); }}
          className="p-1.5 rounded-lg transition-fast" style={{ color: colors.textTertiary }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180,140,60,0.05)'; e.currentTarget.style.color = colors.textSecondary; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textTertiary; }}>
          <X size={13} />
        </button>
      </div>
    </>
  );
}
