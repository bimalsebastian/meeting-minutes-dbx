'use client';

import { useEffect, useState, useCallback } from 'react';

export interface KbFile {
  path: string;
  folder: string;
  name: string;
}

interface KnowledgeGraphProps {
  onFileClick: (file: KbFile) => void;
  onNewFile: () => void;
  refreshTrigger?: number;
}

// Category colour palette (CSS vars + fallbacks)
const FOLDER_COLORS: Record<string, string> = {
  competitive:          '#8B5CF6',
  customers:            '#EC4899',
  products:             '#0A84FF',
  'technical-patterns': '#30D158',
  '':                   '#FF9F0A',   // root files
};

function folderLabel(folder: string) {
  const MAP: Record<string, string> = {
    competitive:          'Competitive',
    customers:            'Customers',
    products:             'Products',
    'technical-patterns': 'Patterns',
    '':                   'Context',
  };
  return MAP[folder] ?? folder;
}

// Place nodes on a circle
function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function KnowledgeGraph({ onFileClick, onNewFile, refreshTrigger }: KnowledgeGraphProps) {
  const [files, setFiles] = useState<KbFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s max
    try {
      const r = await fetch('http://localhost:5167/api/knowledge-store/files', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (r.ok) {
        const d = await r.json();
        setFiles(d.files ?? []);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFiles(); }, [fetchFiles, refreshTrigger]);

  if (loading) return (
    <div className="flex items-center justify-center py-6" style={{ color: 'var(--text-tertiary)' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="animate-spin mr-2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span className="text-xs">Loading…</span>
    </div>
  );

  if (error) return (
    <div className="px-3 py-4 text-center">
      <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
        Backend unavailable
      </p>
      <button
        onClick={fetchFiles}
        className="text-xs px-3 py-1 rounded-lg"
        style={{ background: 'rgba(120,120,128,0.14)', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
      >
        Retry
      </button>
    </div>
  );

  // Group files by folder
  const groups = new Map<string, KbFile[]>();
  for (const f of files) {
    if (!groups.has(f.folder)) groups.set(f.folder, []);
    groups.get(f.folder)!.push(f);
  }
  const folders = [...groups.keys()];

  // Layout constants
  const W = 220, H = 220, CX = W / 2, CY = H / 2;
  const CAT_R = 68;    // category node distance from centre
  const FILE_R = 105;  // file node distance from centre
  const N_FOLDERS = folders.length || 1;

  // Build SVG nodes and edges
  const catNodes: { id: string; x: number; y: number; color: string; label: string }[] = [];
  const fileNodes: { file: KbFile; x: number; y: number; color: string; catX: number; catY: number }[] = [];

  folders.forEach((folder, fi) => {
    const catAngle = (fi / N_FOLDERS) * 360;
    const { x: cx, y: cy } = polar(CX, CY, CAT_R, catAngle);
    const color = FOLDER_COLORS[folder] ?? '#888';
    catNodes.push({ id: folder, x: cx, y: cy, color, label: folderLabel(folder) });

    const folderFiles = groups.get(folder) ?? [];
    const spread = Math.min(30, 50 / (folderFiles.length || 1));
    folderFiles.forEach((file, ffi) => {
      const offset = (ffi - (folderFiles.length - 1) / 2) * spread;
      const fileAngle = catAngle + offset;
      const { x: fx, y: fy } = polar(CX, CY, FILE_R, fileAngle);
      fileNodes.push({ file, x: fx, y: fy, color, catX: cx, catY: cy });
    });
  });

  return (
    <div className="px-2 pb-1">
      <svg
        width={W} height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ overflow: 'visible', display: 'block', margin: '0 auto' }}
      >
        {/* Centre → category edges */}
        {catNodes.map(cat => (
          <line key={`cc-${cat.id}`} x1={CX} y1={CY} x2={cat.x} y2={cat.y}
            stroke={cat.color} strokeWidth="1" strokeOpacity="0.3" />
        ))}

        {/* Category → file edges */}
        {fileNodes.map(({ file, x, y, catX, catY, color }) => (
          <line key={`cf-${file.path}`} x1={catX} y1={catY} x2={x} y2={y}
            stroke={color} strokeWidth="1" strokeOpacity="0.25" />
        ))}

        {/* Centre node */}
        <circle cx={CX} cy={CY} r={10} fill="var(--panel-elevated)" stroke="var(--separator-strong)" strokeWidth="1.5" />
        <text x={CX} y={CY + 4} textAnchor="middle" fontSize="7" fontWeight="700"
          fill="var(--text-secondary)" style={{ userSelect: 'none' }}>KB</text>

        {/* Category nodes */}
        {catNodes.map(cat => (
          <g key={`cn-${cat.id}`}>
            <circle cx={cat.x} cy={cat.y} r={8} fill={cat.color} fillOpacity="0.18"
              stroke={cat.color} strokeWidth="1.5" />
            <text x={cat.x} y={cat.y + (cat.y < CY ? -11 : 14)} textAnchor="middle"
              fontSize="7" fontWeight="600" fill={cat.color} style={{ userSelect: 'none' }}>
              {cat.label}
            </text>
          </g>
        ))}

        {/* File nodes */}
        {fileNodes.map(({ file, x, y, color }) => {
          const hovered = hoveredNode === file.path;
          return (
            <g key={`fn-${file.path}`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredNode(file.path)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={() => onFileClick(file)}
            >
              <circle cx={x} cy={y} r={hovered ? 6 : 5}
                fill={color} fillOpacity={hovered ? 0.9 : 0.55}
                stroke={color} strokeWidth={hovered ? 1.5 : 1}
                style={{ transition: 'all 0.1s' }}
              />
              {hovered && (
                <text x={x} y={y - 9} textAnchor="middle" fontSize="7" fontWeight="600"
                  fill="var(--text-primary)"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {file.name.length > 18 ? file.name.slice(0, 16) + '…' : file.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* New file button */}
      <button
        onClick={onNewFile}
        className="w-full flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium py-1.5 mt-1 transition-colors"
        style={{
          background: 'rgba(120,120,128,0.12)',
          color: 'var(--text-secondary)',
          border: 'none', cursor: 'pointer',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New file
      </button>
    </div>
  );
}
