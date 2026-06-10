'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { KbFile } from './KnowledgeGraph';

interface KnowledgeDrawerProps {
  file: KbFile | null;
  isNew?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const BASE_FOLDERS = ['competitive', 'customers', 'products', 'technical-patterns', ''];
const FOLDER_LABELS: Record<string, string> = {
  competitive:          'competitive/',
  customers:            'customers/',
  products:             'products/',
  'technical-patterns': 'technical-patterns/',
  '':                   '(root)',
};

const MIN_WIDTH = 380;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 480;

export function KnowledgeDrawer({ file, isNew, onClose, onSaved }: KnowledgeDrawerProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // New file state
  const [folders, setFolders] = useState<string[]>(BASE_FOLDERS);
  const [newFolder, setNewFolder] = useState('');
  const [newFilename, setNewFilename] = useState('');
  // "New folder" creation inline
  const [addingFolder, setAddingFolder] = useState(false);
  const [pendingFolder, setPendingFolder] = useState('');

  // Resizable drawer
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_WIDTH);
  const drawerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isOpen = !!file || !!isNew;

  // Fetch file content when editing
  useEffect(() => {
    if (!file) { setContent(''); return; }
    setLoading(true);
    fetch(`http://localhost:5167/api/knowledge-store/file?path=${encodeURIComponent(file.path)}`)
      .then(r => r.ok ? r.json() : { content: '' })
      .then(d => setContent(d.content ?? ''))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [file]);

  // Auto-resize textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [content]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // ── Resize logic ───────────────────────────────────────────────────────────

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = drawerWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [drawerWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startX.current - e.clientX; // drag left = wider
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta));
      setDrawerWidth(next);
    };
    const onUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Folder creation ────────────────────────────────────────────────────────

  const confirmNewFolder = () => {
    const name = pendingFolder.trim().replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
    if (!name) { setAddingFolder(false); return; }
    if (!folders.includes(name)) {
      setFolders(prev => {
        const withoutRoot = prev.filter(f => f !== '');
        return [...withoutRoot, name, ''];
      });
    }
    setNewFolder(name);
    setAddingFolder(false);
    setPendingFolder('');
  };

  // ── Save / Delete ──────────────────────────────────────────────────────────

  const handleSave = async () => {
    const filename = newFilename.endsWith('.md') ? newFilename : newFilename + '.md';
    const path = file
      ? file.path
      : newFolder
        ? `${newFolder}/${filename}`
        : filename;

    if (!path.trim()) return;
    setSaving(true);
    try {
      const r = await fetch('http://localhost:5167/api/knowledge-store/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });
      if (r.ok) { onSaved(); onClose(); }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!file) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      const r = await fetch(
        `http://localhost:5167/api/knowledge-store/file?path=${encodeURIComponent(file.path)}`,
        { method: 'DELETE' }
      );
      if (r.ok) { onSaved(); onClose(); }
    } catch { /* ignore */ }
    finally { setDeleting(false); setConfirmDelete(false); }
  };

  if (!isOpen) return null;

  const breadcrumb = file
    ? (file.folder ? `${file.folder} / ${file.name}.md` : file.name + '.md')
    : 'New file';

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(2px)' }} />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className="fixed top-0 right-0 h-screen z-50 flex flex-col"
        style={{
          width: drawerWidth,
          background: 'var(--panel-bg)',
          borderLeft: '1px solid var(--separator)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.2)',
        }}
      >
        {/* Resize handle — drag the left edge */}
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute top-0 left-0 h-full z-10 flex items-center"
          style={{ width: 6, cursor: 'ew-resize' }}
          title="Drag to resize"
        >
          {/* Visual grip dots */}
          <div className="flex flex-col gap-1 ml-1">
            {[0,1,2].map(i => (
              <div key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--separator-strong)' }} />
            ))}
          </div>
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--separator)' }}>
          <div className="flex-1 min-w-0 ml-3">
            <p className="text-xs mb-0.5" style={{ color: 'var(--text-tertiary)' }}>Knowledge Store</p>
            <p className="text-sm font-semibold truncate font-mono" style={{ color: 'var(--text-primary)' }}>
              {breadcrumb}
            </p>
          </div>
          <button onClick={onClose}
            className="flex-shrink-0 flex items-center justify-center rounded-lg w-7 h-7"
            style={{ background: 'rgba(120,120,128,0.14)', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* New file: folder + filename row */}
        {isNew && !file && (
          <div className="flex flex-col gap-2 px-4 py-3 flex-shrink-0 ml-3"
            style={{ borderBottom: '1px solid var(--separator)' }}>
            <div className="flex gap-2 items-center">
              {/* Folder selector */}
              {addingFolder ? (
                <div className="flex gap-1 items-center">
                  <input
                    autoFocus
                    placeholder="new-folder"
                    value={pendingFolder}
                    onChange={e => setPendingFolder(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') confirmNewFolder(); if (e.key === 'Escape') { setAddingFolder(false); setPendingFolder(''); } }}
                    className="text-xs rounded-lg px-2 py-1.5 font-mono w-32"
                    style={{ background: 'var(--panel-elevated)', border: '1px solid var(--accent-hex)', color: 'var(--text-primary)', outline: 'none' }}
                  />
                  <button onClick={confirmNewFolder}
                    className="text-xs px-2 py-1.5 rounded-lg"
                    style={{ background: 'var(--accent-hex)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    Add
                  </button>
                  <button onClick={() => { setAddingFolder(false); setPendingFolder(''); }}
                    className="text-xs px-2 py-1.5 rounded-lg"
                    style={{ background: 'rgba(120,120,128,0.12)', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <select
                    value={newFolder}
                    onChange={e => {
                      if (e.target.value === '__new__') { setAddingFolder(true); }
                      else setNewFolder(e.target.value);
                    }}
                    className="text-xs rounded-lg px-2 py-1.5 flex-shrink-0"
                    style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)', color: 'var(--text-primary)', cursor: 'pointer' }}
                  >
                    {folders.map(f => (
                      <option key={f} value={f}>
                        {FOLDER_LABELS[f] ?? `${f}/`}
                      </option>
                    ))}
                    <option value="__new__">+ New folder…</option>
                  </select>
                  <input
                    autoFocus={!addingFolder}
                    placeholder="filename.md"
                    value={newFilename}
                    onChange={e => setNewFilename(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && newFilename.trim()) handleSave(); }}
                    className="flex-1 text-xs rounded-lg px-2 py-1.5 font-mono"
                    style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)', color: 'var(--text-primary)', outline: 'none' }}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar ml-3">
          {loading ? (
            <div className="flex items-center justify-center h-32" style={{ color: 'var(--text-tertiary)' }}>
              Loading…
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={isNew ? '# New Knowledge File\n\nStart writing…' : ''}
              className="w-full resize-none text-sm font-mono leading-relaxed focus:outline-none"
              style={{ background: 'transparent', color: 'var(--text-primary)', border: 'none', minHeight: '60vh', lineHeight: 1.7 }}
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0 ml-3"
          style={{ borderTop: '1px solid var(--separator)' }}>
          {file && (
            <button onClick={handleDelete} disabled={deleting}
              className="text-xs px-3 py-1.5 rounded-lg font-medium"
              style={{
                background: confirmDelete ? 'rgba(255,69,58,0.15)' : 'rgba(120,120,128,0.12)',
                color: confirmDelete ? '#FF453A' : 'var(--text-secondary)',
                border: `1px solid ${confirmDelete ? 'rgba(255,69,58,0.4)' : 'transparent'}`,
                cursor: 'pointer',
              }}>
              {deleting ? 'Deleting…' : confirmDelete ? 'Confirm delete' : 'Delete'}
            </button>
          )}
          {confirmDelete && (
            <button onClick={() => setConfirmDelete(false)}
              className="text-xs px-2 py-1.5 rounded-lg"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
              Cancel
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-lg font-medium"
            style={{ background: 'rgba(120,120,128,0.12)', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            Cancel
          </button>
          <button onClick={handleSave}
            disabled={saving || (!!isNew && !newFilename.trim())}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-opacity disabled:opacity-40"
            style={{ background: 'var(--accent-hex)', color: '#fff', border: 'none', cursor: 'pointer' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
