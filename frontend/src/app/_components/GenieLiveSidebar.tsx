'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { parseGenieAnswer } from '@/lib/parseGenieAnswer';

interface GenieSource {
  url: string;
  title?: string;
}

interface CopilotHint {
  id: string;
  meeting_id: string;
  created_at: string;
  updated_at?: string;
  cycle_number?: number;
  extracted_query?: string;
  talking_points: string[];
  genie_status?: 'pending' | 'complete' | 'timeout' | 'unavailable';
  genie_raw_answer?: string | null;
  genie_sources: GenieSource[];
  genie_conversation_id?: string | null;
  genie_poll_attempts?: number | null;
  genie_response_time_seconds?: number | null;
  llm_fallback_used: boolean;
}

interface GenieLiveSidebarProps {
  meetingId: string | null;
  isRecording: boolean;
  isEnabled: boolean;
  width?: number;
  geniePaused?: boolean;
  onToggleGeniePause?: () => void;
}

async function openUrl(url: string) {
  try { await invoke('open_external_url', { url }); }
  catch { window.open(url, '_blank'); }
}

// ── GenieMark icon ────────────────────────────────────────────────────────────

function GenieMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" style={{ flexShrink: 0 }}>
      <path d="M209 409C192 409 178 426 178 448h146c0-22-14-39-31-39H209Z" fill="var(--coral)" />
      <path d="M460 207C429 257 382 325 362 343c-21 17-52 49-123 49-50 0-93-32-112-78l-1 3c-3-7-9-12-17-12-10 0-18 8-18 18 0 2 0 4 1 6 4 10 16 10 16 42h-1c-30 0-55-25-55-55s25-55 55-55h92c7 0 13 3 17 8 7 9 12 17 16 24 4 6 15 6 19 0 4-7 9-15 15-24 4-5 11-8 18-8h32c47 0 73-23 86-39 7-9 17-14 28-14h24Z"
        fill="var(--coral-dim)" style={{ fillOpacity: 1 }} />
      <path d="M247 286c0-61-49-111-109-111 60 0 109-50 109-111 0 61 49 111 109 111-60 0-109 50-109 111Z" fill="var(--coral)" />
    </svg>
  );
}

// ── Animated "analyzing" bar indicator ───────────────────────────────────────

function AnalyzingBars() {
  const heights = [0.4, 0.85, 0.55, 1.0, 0.65];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2.5, height: 15 }}>
      {heights.map((v, i) => (
        <span key={i} style={{
          width: 3, height: '100%', borderRadius: 2,
          background: 'var(--coral)', transformOrigin: 'bottom',
          transform: `scaleY(${v})`,
          animation: `barsPulse ${0.6 + i * 0.1}s ease-in-out infinite`,
        }} />
      ))}
    </div>
  );
}

// ── Icon action button ────────────────────────────────────────────────────────

function IconAct({ children, onClick, active = false, accentActive = false }: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  accentActive?: boolean;
}) {
  const [hov, setHov] = useState(false);
  const col = active
    ? (accentActive ? 'var(--coral)' : 'var(--accent-hex)')
    : (hov ? 'var(--text-primary)' : 'var(--text-secondary)');
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        all: 'unset', cursor: 'pointer', width: 28, height: 28, borderRadius: 7,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: col,
        background: hov ? 'rgba(120,120,128,0.18)' : 'transparent',
        transition: 'color .13s, background .13s',
      }}
    >{children}</button>
  );
}

// ── Link row inside card ──────────────────────────────────────────────────────

function LinkRow({ url, label, meta }: { url: string; label: string; meta?: string }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={() => openUrl(url)}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 9px', borderRadius: 9, textDecoration: 'none',
        background: hov ? 'rgba(255,95,70,0.08)' : 'transparent',
        transition: 'background .13s',
      }}
    >
      <span style={{
        flexShrink: 0, width: 26, height: 26, borderRadius: 7,
        background: 'var(--coral-tint)', color: 'var(--coral)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>
        </svg>
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500,
        color: hov ? 'var(--coral-bright)' : 'var(--text-primary)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      {meta && (
        <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--text-tertiary)', fontFamily: 'ui-monospace, monospace' }}>
          {meta}
        </span>
      )}
    </button>
  );
}

// ── Suggestion card ───────────────────────────────────────────────────────────

function HintCard({ hint, isNewest, onDismiss, isExpanded, onToggle }: {
  hint: CopilotHint;
  isNewest: boolean;
  onDismiss: (id: string) => void;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const [pinned, setPinned] = useState(false);

  const isPending = hint.genie_status === 'pending';
  const isFallback = hint.llm_fallback_used;
  const confidence = isFallback ? 'Medium' : 'High';

  // Extract structured content
  const { quickLinks } = parseGenieAnswer(hint.genie_raw_answer);

  // Combine sources
  const allLinks: { url: string; label: string; meta?: string }[] = [
    ...hint.genie_sources.map(s => ({ url: s.url, label: s.title || s.url, meta: 'source' })),
    ...quickLinks.map(l => ({ url: l.url, label: l.text, meta: l.description ? l.description.slice(0, 20) : undefined })),
  ].filter((l, i, arr) => arr.findIndex(x => x.url === l.url) === i); // dedupe by URL

  // Primary action: first source, or first talking point as text
  const primarySource = allLinks[0] ?? null;
  const primaryTalking = hint.talking_points[0] ?? null;

  // Format time
  const time = new Date(hint.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const detailCount = `${hint.talking_points.length} talking point${hint.talking_points.length !== 1 ? 's' : ''} · ${allLinks.length} link${allLinks.length !== 1 ? 's' : ''}`;

  if (isPending) {
    return (
      <div style={{
        background: 'var(--panel-elevated)', borderRadius: 14,
        boxShadow: '0 0 0 1px var(--separator)',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px',
          background: 'var(--coral-tint-2)', borderBottom: '1px dashed rgba(255,95,70,0.25)' }}>
          <AnalyzingBars />
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--coral)' }}>
            Genie is analyzing the conversation…
          </span>
        </div>
        <div style={{ padding: '10px 14px 12px' }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            {hint.extracted_query ?? 'Processing…'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: 'var(--panel-elevated)', borderRadius: 14,
      boxShadow: isNewest
        ? '0 0 0 1px rgba(255,95,70,0.4), 0 10px 30px rgba(0,0,0,0.35)'
        : '0 0 0 1px var(--separator), 0 4px 14px rgba(0,0,0,0.2)',
      overflow: 'hidden',
      animation: isNewest ? 'cardIn .45s cubic-bezier(.2,.7,.2,1)' : 'none',
    }}>
      {/* Coral accent rail on newest card */}
      {isNewest && (
        <div style={{ height: 3, background: 'linear-gradient(90deg, var(--coral), var(--coral-bright))' }} />
      )}

      <div style={{ padding: '13px 15px 14px' }}>
        {/* Eyebrow: topic + NEW badge + time */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
          <GenieMark size={14} />
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: 'var(--coral)' }}>
            Check {hint.cycle_number ?? ''}
          </span>
          <div style={{ flex: 1 }} />
          {isNewest && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em',
              color: 'var(--coral)', background: 'var(--coral-tint)',
              borderRadius: 20, padding: '2px 8px 2px 7px',
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--coral)',
                display: 'inline-block', animation: 'liveDot 1.4s ease-in-out infinite' }} />
              NEW
            </span>
          )}
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)',
            fontFamily: 'ui-monospace, monospace' }}>{time}</span>
        </div>

        {/* Headline — the glanceable signal */}
        <p style={{ fontSize: 15, lineHeight: 1.38, fontWeight: 600, letterSpacing: '-0.01em',
          color: 'var(--text-primary)', marginBottom: 11 }}>
          {hint.extracted_query ?? `Genie check ${hint.cycle_number}`}
        </p>

        {/* Primary action — always visible */}
        {primarySource ? (
          <button
            onClick={() => openUrl(primarySource.url)}
            style={{
              all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
              display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px',
              background: 'var(--coral-tint)', border: '1px solid rgba(255,95,70,0.28)',
              borderRadius: 10, transition: 'background .15s, border-color .15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,95,70,0.2)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,95,70,0.5)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--coral-tint)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,95,70,0.28)'; }}
          >
            <span style={{
              flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
              background: 'var(--coral)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M8 5l11 7-11 7V5z"/>
              </svg>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600,
                color: 'var(--text-primary)', lineHeight: 1.25 }}>{primarySource.label}</span>
              {primarySource.meta && (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                  {primarySource.meta}
                </span>
              )}
            </span>
          </button>
        ) : primaryTalking ? (
          <div style={{
            padding: '9px 12px',
            background: 'var(--coral-tint)', border: '1px solid rgba(255,95,70,0.18)',
            borderRadius: 10,
          }}>
            <p style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--text-primary)' }}>{primaryTalking}</p>
          </div>
        ) : null}

        {/* Disclosure toggle */}
        {(hint.talking_points.length > 0 || allLinks.length > 0) && (
          <button
            onClick={() => onToggle(hint.id)}
            style={{
              all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 11,
              fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)',
            }}
          >
            <span style={{
              display: 'inline-flex',
              transform: isExpanded ? 'rotate(180deg)' : 'none',
              transition: 'transform .2s',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </span>
            {isExpanded ? 'Hide details' : detailCount}
          </button>
        )}

        {/* Expandable body */}
        {isExpanded && (
          <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Talking points */}
            {hint.talking_points.length > 0 && (
              <div>
                <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em',
                  textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 8 }}>
                  Talking points
                </p>
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {hint.talking_points.map((pt, i) => (
                    <li key={i} style={{ display: 'flex', gap: 9, fontSize: 13, lineHeight: 1.45, color: 'var(--text-primary)' }}>
                      <span style={{ flexShrink: 0, marginTop: 7, width: 5, height: 5,
                        borderRadius: '50%', background: 'var(--coral)' }} />
                      <span style={{ flex: 1 }}>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Links to share */}
            {allLinks.length > 0 && (
              <div>
                <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em',
                  textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                  Links to share
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {allLinks.map((l, i) => (
                    <LinkRow key={i} url={l.url} label={l.label} meta={l.meta} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3,
        padding: '8px 11px', borderTop: '1px solid var(--separator)',
        background: 'rgba(0,0,0,0.12)',
      }}>
        {/* Voting */}
        <IconAct active={vote === 'up'} onClick={() => setVote(v => v === 'up' ? null : 'up')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z"/><path d="M7 11l4-7a2 2 0 0 1 2.6 2.6L12.5 10H19a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 18 20H7"/>
          </svg>
        </IconAct>
        <IconAct active={vote === 'down'} onClick={() => setVote(v => v === 'down' ? null : 'down')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M17 13V4h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3z"/><path d="M17 13l-4 7a2 2 0 0 1-2.6-2.6L11.5 14H5a2 2 0 0 1-2-2.3l1-6A2 2 0 0 1 6 4h11"/>
          </svg>
        </IconAct>

        <div style={{ width: 1, height: 14, background: 'var(--separator)', margin: '0 3px' }} />

        {/* Confidence */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: confidence === 'High' ? 'var(--green)' : '#FFAB00' }} />
          {confidence}
          {hint.genie_sources.length > 0 && ` · ${hint.genie_sources.length} sources`}
          {hint.genie_response_time_seconds != null && (
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>
              {' '}{hint.genie_response_time_seconds.toFixed(0)}s
            </span>
          )}
        </span>

        <div style={{ flex: 1 }} />

        {/* Pin */}
        <IconAct active={pinned} accentActive onClick={() => setPinned(p => !p)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 15v5"/>
          </svg>
        </IconAct>

        {/* Dismiss */}
        <IconAct onClick={() => onDismiss(hint.id)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </IconAct>
      </div>
    </div>
  );
}

// ── Empty / waiting state ─────────────────────────────────────────────────────

function EmptyState({ isRecording, nextCycleSeconds }: { isRecording: boolean; nextCycleSeconds: number | null }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14, opacity: 0.5 }}>
        <GenieMark size={32} />
      </div>
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        {isRecording ? 'Listening for insights' : 'No insights this session'}
      </p>
      <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 220, margin: '0 auto' }}>
        {isRecording
          ? nextCycleSeconds != null
            ? `First check in ${nextCycleSeconds}s`
            : 'Suggestions will appear as topics come up.'
          : 'Genie Live captures insights while you record.'}
      </p>
    </div>
  );
}

// ── Main sidebar ──────────────────────────────────────────────────────────────

export default function GenieLiveSidebar({ meetingId, isRecording, isEnabled, width, geniePaused = false, onToggleGeniePause }: GenieLiveSidebarProps) {
  const [hints, setHints] = useState<CopilotHint[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [nextCycleSeconds, setNextCycleSeconds] = useState<number | null>(null);
  const activeMeetingIdRef = useRef<string | null>(null);
  const recordingStartRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const intervalMinutes = 5;

  // Countdown to next cycle
  useEffect(() => {
    if (!isRecording || !recordingStartRef.current) return;
    const tick = setInterval(() => {
      const elapsed = (Date.now() - (recordingStartRef.current ?? Date.now())) / 1000;
      let next: number;
      if (elapsed < 45) {
        next = Math.ceil(45 - elapsed);
      } else {
        const elapsedAfterFirst = elapsed - 45;
        const cycleSecs = intervalMinutes * 60;
        next = Math.ceil(cycleSecs - (elapsedAfterFirst % cycleSecs));
      }
      setNextCycleSeconds(next);
    }, 1000);
    return () => clearInterval(tick);
  }, [isRecording]);

  // Signal recording start/stop
  useEffect(() => {
    const signal = async () => {
      let signalMeetingId = meetingId;
      if (isRecording) {
        recordingStartRef.current = Date.now();
        try {
          const rustId = await invoke<string | null>('get_current_meeting_id');
          if (rustId) { signalMeetingId = rustId; activeMeetingIdRef.current = rustId; }
        } catch { /* SSR */ }
      } else {
        activeMeetingIdRef.current = null;
        recordingStartRef.current = null;
        setNextCycleSeconds(null);
      }
      if (!signalMeetingId) return;
      fetch('http://localhost:5167/api/copilot/recording-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: isRecording ? 'start' : 'stop', meeting_id: signalMeetingId }),
      }).catch(() => {});
    };
    signal();
  }, [isRecording, meetingId]);

  // Poll for hints
  useEffect(() => {
    if (!isEnabled || !isRecording) return;
    const poll = async () => {
      const pollId = activeMeetingIdRef.current || meetingId;
      if (!pollId) return;
      try {
        const r = await fetch(`http://localhost:5167/api/copilot/hints/${pollId}`);
        const d = await r.json();
        const incoming: CopilotHint[] = d.hints ?? [];
        if (incoming.length === 0) return;
        setHints(prev => {
          const byId = new Map(prev.map(h => [h.id, h]));
          for (const h of incoming) byId.set(h.id, h);
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
        });
      } catch {}
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, [isEnabled, isRecording, meetingId]);

  // Auto-expand newly completed hints
  const prevCompleteIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const completeHints = hints.filter(h => h.genie_status !== 'pending');
    const newlyComplete = completeHints.filter(h => !prevCompleteIds.current.has(h.id));
    if (newlyComplete.length > 0) {
      const toExpand = newlyComplete.reduce((latest, h) =>
        new Date(h.created_at) > new Date(latest.created_at) ? h : latest
      );
      setExpandedId(toExpand.id);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCompleteIds.current = new Set(completeHints.map(h => h.id));
  }, [hints]);

  const dismiss = useCallback((id: string) => setDismissed(prev => new Set(prev).add(id)), []);
  const toggleExpand = useCallback((id: string) => setExpandedId(prev => prev === id ? null : id), []);

  const visibleHints = hints.filter(h => !dismissed.has(h.id));
  // Most recently created non-pending hint = "newest"
  const newestId = visibleHints
    .filter(h => h.genie_status !== 'pending')
    .at(-1)?.id ?? null;

  // When `width` is provided → fixed-width sidebar (legacy use).
  // When omitted → fill available flex space (new top-zone layout).
  const panelStyle: React.CSSProperties = width
    ? { width, flexShrink: 0, borderLeft: '1px solid var(--separator)' }
    : { flex: '1 1 0', minWidth: 0 };

  const outerClass = width
    ? 'flex-shrink-0 flex flex-col overflow-hidden bg-[var(--panel-bg)]'
    : 'flex flex-col overflow-hidden h-full bg-[var(--panel-bg)]';

  if (!isEnabled) {
    return (
      <div className={outerClass + ' items-center justify-center p-6 text-center'}
        style={panelStyle}>
        <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Genie Live disabled</p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Enable in Settings → Genie Live</p>
      </div>
    );
  }

  return (
    <div className={outerClass} style={panelStyle}>

      {/* Panel header */}
      <div style={{
        flexShrink: 0, padding: '14px 16px 12px',
        borderBottom: '1px solid var(--separator)',
        display: 'flex', alignItems: 'center', gap: 11,
      }}>
        <GenieMark size={22} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>
              Genie
            </h1>
            {isRecording && !geniePaused && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
                color: 'var(--coral)', border: '1px solid rgba(255,95,70,0.4)',
                borderRadius: 20, padding: '1px 8px 1px 6px',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--coral)',
                  animation: 'liveDot 1.4s ease-in-out infinite' }} />
                LIVE
              </span>
            )}
            {isRecording && geniePaused && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em',
                color: 'var(--text-secondary)', border: '1px solid var(--separator)',
                borderRadius: 20, padding: '1px 8px 1px 6px',
              }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
                </svg>
                PAUSED
              </span>
            )}
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>
            {!isRecording ? 'Session ended'
              : geniePaused ? 'Paused — suggestions will resume when you continue'
              : 'Listening to this meeting'}
          </p>
        </div>
        {visibleHints.length > 0 && (
          <span style={{
            fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
            background: 'rgba(120,120,128,0.18)', borderRadius: 20, padding: '2px 9px',
          }}>{visibleHints.length}</span>
        )}
        {/* Pause / Resume button — only during an active recording */}
        {isRecording && onToggleGeniePause && (
          <button
            onClick={onToggleGeniePause}
            title={geniePaused ? 'Resume Genie Live' : 'Pause Genie Live'}
            style={{
              all: 'unset', cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: 8,
              background: geniePaused ? 'var(--coral-tint)' : 'rgba(120,120,128,0.14)',
              color: geniePaused ? 'var(--coral)' : 'var(--text-secondary)',
              border: geniePaused ? '1px solid rgba(255,95,70,0.3)' : 'none',
              transition: 'background .15s, color .15s',
            }}
          >
            {geniePaused ? (
              /* Resume: play triangle */
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M8 5l11 7-11 7V5z"/>
              </svg>
            ) : (
              /* Pause: two bars */
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Paused banner */}
      {isRecording && geniePaused && visibleHints.length > 0 && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
          padding: '9px 14px', margin: '10px 12px 0',
          background: 'rgba(120,120,128,0.08)',
          border: '1px dashed var(--separator)',
          borderRadius: 10,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"
            style={{ flexShrink: 0, color: 'var(--text-secondary)' }}>
            <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Genie is paused. {visibleHints.length} suggestion{visibleHints.length !== 1 ? 's' : ''} waiting — press ▶ to resume.
          </span>
        </div>
      )}

      {/* Hint stack */}
      <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ padding: '12px 12px 16px' }}>
        {visibleHints.length === 0 ? (
          <EmptyState isRecording={isRecording} nextCycleSeconds={geniePaused ? null : nextCycleSeconds} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visibleHints.map(hint => (
              <HintCard
                key={hint.id}
                hint={hint}
                isNewest={hint.id === newestId}
                onDismiss={dismiss}
                isExpanded={hint.genie_status === 'pending' || expandedId === hint.id}
                onToggle={toggleExpand}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
