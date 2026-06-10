'use client';

import { useState, useEffect, useCallback } from 'react';
import { KnowledgeDrawer } from '@/app/_components/KnowledgeDrawer';
import type { KbFile } from '@/app/_components/KnowledgeGraph';

// ── Colour + label maps ───────────────────────────────────────────────────────

const FOLDER_COLORS: Record<string, string> = {
  competitive:          '#8B5CF6',
  customers:            '#EC4899',
  products:             '#0A84FF',
  'technical-patterns': '#30D158',
  '':                   '#FF9F0A',
};

const FOLDER_LABELS: Record<string, string> = {
  competitive:          'Competitive',
  customers:            'Customers',
  products:             'Products',
  'technical-patterns': 'Patterns',
  '':                   'Context',
};

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// ── Full-size graph ───────────────────────────────────────────────────────────

function KnowledgeGraphFull({
  refreshTrigger,
  onFileClick,
  onNewFile,
}: {
  refreshTrigger: number;
  onFileClick: (f: KbFile) => void;
  onNewFile: () => void;
}) {
  const [files, setFiles] = useState<KbFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(false);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch('http://localhost:5167/api/knowledge-store/files', { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) setFiles((await r.json()).files ?? []);
      else setError(true);
    } catch { setError(true); }
    finally { clearTimeout(t); setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  if (loading) return (
    <div className="flex flex-col items-center gap-3" style={{ color: 'var(--text-secondary)' }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span className="text-sm">Loading knowledge store…</span>
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Backend unavailable</p>
      <button onClick={load} className="text-sm px-4 py-2 rounded-lg"
        style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)', cursor: 'pointer', color: 'var(--text-primary)' }}>
        Retry
      </button>
    </div>
  );

  if (files.length === 0) return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No files in knowledge store</p>
      <button onClick={onNewFile}
        className="text-sm px-4 py-2 rounded-lg font-medium"
        style={{ background: 'var(--accent-hex)', color: '#fff', border: 'none', cursor: 'pointer' }}>
        Create first file
      </button>
    </div>
  );

  // Build layout
  const W = 560, H = 480, CX = W / 2, CY = H / 2;
  const CAT_R = 130, FILE_R = 215;

  const groups = new Map<string, KbFile[]>();
  for (const f of files) {
    if (!groups.has(f.folder)) groups.set(f.folder, []);
    groups.get(f.folder)!.push(f);
  }
  const folders = [...groups.keys()];
  const N = folders.length || 1;

  const catNodes: { id: string; x: number; y: number; color: string; label: string }[] = [];
  const fileNodes: { file: KbFile; x: number; y: number; color: string; catX: number; catY: number }[] = [];

  folders.forEach((folder, fi) => {
    const angle = (fi / N) * 360;
    const { x: cx, y: cy } = polar(CX, CY, CAT_R, angle);
    const color = FOLDER_COLORS[folder] ?? '#888';
    catNodes.push({ id: folder, x: cx, y: cy, color, label: FOLDER_LABELS[folder] ?? folder });

    const folderFiles = groups.get(folder) ?? [];
    const spread = Math.min(28, 55 / (folderFiles.length || 1));
    folderFiles.forEach((file, ffi) => {
      const offset = (ffi - (folderFiles.length - 1) / 2) * spread;
      const { x: fx, y: fy } = polar(CX, CY, FILE_R, angle + offset);
      fileNodes.push({ file, x: fx, y: fy, color, catX: cx, catY: cy });
    });
  });

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
      {catNodes.map(c => (
        <line key={`ec-${c.id}`} x1={CX} y1={CY} x2={c.x} y2={c.y}
          stroke={c.color} strokeWidth="1.5" strokeOpacity="0.25" />
      ))}
      {fileNodes.map(({ file, x, y, catX, catY, color }) => (
        <line key={`ef-${file.path}`} x1={catX} y1={catY} x2={x} y2={y}
          stroke={color} strokeWidth="1" strokeOpacity="0.2" />
      ))}

      {/* Centre */}
      <circle cx={CX} cy={CY} r={18} fill="var(--panel-elevated)" stroke="var(--separator-strong)" strokeWidth="2" />
      <text x={CX} y={CY + 5} textAnchor="middle" fontSize="11" fontWeight="700"
        fill="var(--text-secondary)" style={{ userSelect: 'none' }}>KB</text>

      {/* Category nodes */}
      {catNodes.map(c => (
        <g key={`cn-${c.id}`}>
          <circle cx={c.x} cy={c.y} r={15} fill={c.color} fillOpacity="0.15" stroke={c.color} strokeWidth="2" />
          <text x={c.x} y={c.y + 5} textAnchor="middle" fontSize="10" fontWeight="700"
            fill={c.color} style={{ userSelect: 'none' }}>{c.label}</text>
        </g>
      ))}

      {/* File nodes */}
      {fileNodes.map(({ file, x, y, color }) => {
        const isHov = hovered === file.path;
        const labelY = y > CY ? y + 22 : y - 14;
        return (
          <g key={`fn-${file.path}`} style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHovered(file.path)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onFileClick(file)}>
            <circle cx={x} cy={y} r={isHov ? 10 : 7}
              fill={color} fillOpacity={isHov ? 0.95 : 0.6}
              stroke={color} strokeWidth={isHov ? 2 : 1.5}
              style={{ transition: 'all 0.12s' }} />
            <text x={x} y={labelY} textAnchor="middle"
              fontSize={isHov ? 11 : 9} fontWeight={isHov ? '700' : '500'}
              fill={isHov ? 'var(--text-primary)' : 'var(--text-secondary)'}
              style={{ userSelect: 'none', transition: 'all 0.12s' }}>
              {file.name.length > 22 ? file.name.slice(0, 20) + '…' : file.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KnowledgePage() {
  const [drawerFile, setDrawerFile] = useState<KbFile | null>(null);
  const [drawerIsNew, setDrawerIsNew] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--app-bg)' }}>
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-3 px-6 py-4"
        style={{ borderBottom: '1px solid var(--separator)', background: 'var(--panel-bg)' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
          style={{ color: 'var(--accent-hex)', flexShrink: 0 }}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <div>
          <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Knowledge Store
          </h1>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Click any node to view or edit · hover to identify
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => { setDrawerFile(null); setDrawerIsNew(true); }}
          className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
          style={{ background: 'var(--accent-hex)', color: '#fff', border: 'none', cursor: 'pointer' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New file
        </button>
      </div>

      {/* Graph centred in remaining space */}
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <KnowledgeGraphFull
          refreshTrigger={refreshTrigger}
          onFileClick={f => { setDrawerIsNew(false); setDrawerFile(f); }}
          onNewFile={() => { setDrawerFile(null); setDrawerIsNew(true); }}
        />
      </div>

      <KnowledgeDrawer
        file={drawerFile}
        isNew={drawerIsNew}
        onClose={() => { setDrawerFile(null); setDrawerIsNew(false); }}
        onSaved={() => setRefreshTrigger(t => t + 1)}
      />
    </div>
  );
}
