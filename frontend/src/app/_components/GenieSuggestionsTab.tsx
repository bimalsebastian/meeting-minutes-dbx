'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { parseGenieAnswer } from '@/lib/parseGenieAnswer';

// ── Types ─────────────────────────────────────────────────────────────────────

interface GenieHint {
  id: string;
  cycle_number: number;
  extracted_query: string | null;
  genie_raw_answer: string | null;
  genie_status: string;
  timestamp: number;
  created_at: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'genie' | 'error';
  content: string;
}

function formatSecs(s: number) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function openUrl(url: string) {
  try { await invoke('open_external_url', { url }); }
  catch { window.open(url, '_blank'); }
}

// ── GenieMark icon ────────────────────────────────────────────────────────────

function GenieMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" style={{ flexShrink: 0 }}>
      <path d="M209 409C192 409 178 426 178 448h146c0-22-14-39-31-39H209Z" fill="var(--db-lava)" />
      <path d="M460 207C429 257 382 325 362 343c-21 17-52 49-123 49-50 0-93-32-112-78l-1 3c-3-7-9-12-17-12-10 0-18 8-18 18 0 2 0 4 1 6 4 10 16 10 16 42h-1c-30 0-55-25-55-55s25-55 55-55h92c7 0 13 3 17 8 7 9 12 17 16 24 4 6 15 6 19 0 4-7 9-15 15-24 4-5 11-8 18-8h32c47 0 73-23 86-39 7-9 17-14 28-14h24Z"
        fill="var(--db-lava-tint)" style={{ fillOpacity: 1 }} />
      <path d="M247 286c0-61-49-111-109-111 60 0 109-50 109-111 0 61 49 111 109 111-60 0-109 50-109 111Z" fill="var(--db-lava)" />
    </svg>
  );
}

// ── Suggestion card ───────────────────────────────────────────────────────────

function SuggestionCard({ hint, index, isExpanded, onToggle }: {
  hint: GenieHint; index: number; isExpanded: boolean; onToggle: () => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const { quickLinks, nextSteps } = parseGenieAnswer(hint.genie_raw_answer);
  const primaryLink = quickLinks[0] ?? null;
  const remainingLinks = quickLinks.slice(1);
  const detailCount = `${nextSteps.length > 0 ? nextSteps.length + ' talking point' + (nextSteps.length > 1 ? 's' : '') : ''}${nextSteps.length > 0 && quickLinks.length > 0 ? ' · ' : ''}${quickLinks.length > 0 ? quickLinks.length + ' link' + (quickLinks.length > 1 ? 's' : '') : ''}`;

  return (
    <div
      className="rounded-xl overflow-hidden transition-all"
      style={{
        background: 'var(--panel-bg)',
        border: '1px solid var(--db-line)',
        boxShadow: isExpanded
          ? '0 2px 6px rgba(0,0,0,0.06),0 8px 20px rgba(0,0,0,0.06)'
          : '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      {/* Header — click to toggle */}
      <button
        onClick={onToggle}
        className="flex gap-3 w-full text-left"
        style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', gap: 12, padding: '13px 15px', alignItems: 'flex-start' }}
      >
        {/* Order badge */}
        <span style={{
          flexShrink: 0, width: 24, height: 24, borderRadius: 7,
          background: 'var(--db-navy)', color: 'var(--panel-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, marginTop: 1,
        }}>{index}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {/* Topic + timestamp row */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <GenieMark size={13} />
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--db-lava)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {hint.extracted_query ?? `Check ${hint.cycle_number}`}
            </span>
            {hint.timestamp > 0 && (
              <span style={{ fontSize: 10.5, fontFamily: 'ui-monospace, monospace', color: 'var(--db-ink-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {formatSecs(hint.timestamp)}
              </span>
            )}
          </span>
          {/* Headline */}
          {!isExpanded && (
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, lineHeight: 1.4, color: 'var(--db-navy)' }}>
              {/* Show first sentence of answer or query */}
              {hint.genie_raw_answer
                ? hint.genie_raw_answer.split('\n').find(l => l.trim() && !l.startsWith('#'))?.slice(0, 120) ?? hint.extracted_query
                : hint.extracted_query}
            </span>
          )}
        </span>
        <span style={{ flexShrink: 0, marginTop: 2, color: 'var(--db-ink-muted)', display: 'inline-flex', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
        </span>
      </button>

      {/* Collapsed: primary action button */}
      {!isExpanded && primaryLink && (
        <div style={{ padding: '0 15px 13px 51px' }}>
          <button
            onClick={() => openUrl(primaryLink.url)}
            style={{
              all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
              background: 'var(--db-lava-tint)', border: '1px solid rgba(255,54,33,0.18)',
              borderRadius: 9, transition: 'background .13s',
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,54,33,0.18)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--db-lava-tint)'}
          >
            <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: '50%', background: 'var(--db-lava)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5l11 7-11 7V5z"/></svg>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--db-navy)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primaryLink.text}</span>
              {primaryLink.description && (
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--db-ink-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primaryLink.description}</span>
              )}
            </span>
          </button>
          {/* Expand toggle */}
          {detailCount && (
            <button
              onClick={onToggle}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, marginTop: 9, fontSize: 12, color: 'var(--db-ink-muted)' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
              {detailCount}
            </button>
          )}
        </div>
      )}

      {/* Expanded body */}
      {isExpanded && (
        <div style={{ padding: '2px 15px 15px 51px' }}>
          {/* Quick links */}
          {quickLinks.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--db-ink-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Quick links to share
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 14 }}>
                {quickLinks.map((l, i) => (
                  <button
                    key={i}
                    onClick={() => openUrl(l.url)}
                    style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 8, transition: 'background .12s' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--db-oat)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <span style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: 'var(--db-lava-tint)', color: 'var(--db-lava)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/></svg>
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--db-navy)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.text}</span>
                      {l.description && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--db-ink-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Next steps */}
          {nextSteps.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--db-ink-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                Suggested next steps
              </div>
              <ol style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 14 }}>
                {nextSteps.map((step, i) => (
                  <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.45, color: 'var(--db-ink)' }}>
                    <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', border: '1.5px solid var(--db-lava)', color: 'var(--db-lava)', fontSize: 10.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>{i + 1}</span>
                    <span style={{ flex: 1 }}>{step}</span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {/* Full answer toggle */}
          <button
            onClick={() => setShowFull(v => !v)}
            style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--db-ink-muted)' }}
          >
            <span style={{ display: 'inline-flex', transform: showFull ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </span>
            {showFull ? 'Hide full answer' : 'Show full answer'}
          </button>
          {showFull && (
            <div className="genie-md text-sm mt-2 p-3 rounded-lg" style={{ background: 'var(--db-oat)', border: '1px solid var(--db-line)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--db-ink-soft)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{hint.genie_raw_answer ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Conversation section ──────────────────────────────────────────────────────

function ConversationStarters({ onPick }: { onPick: (q: string) => void }) {
  const starters = [
    'What were the key decisions made in this meeting?',
    'What are the open action items from this meeting?',
    'Summarise the technical architecture discussed.',
    'What objections were raised and how were they handled?',
  ];
  return (
    <div>
      <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--db-ink-soft)', marginBottom: 12 }}>
        Ask Genie a follow-up about this meeting. Answers are grounded in the transcript and your workspace data.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {starters.map((s, i) => (
          <button
            key={i}
            onClick={() => onPick(s)}
            style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', background: 'var(--panel-bg)', border: '1px solid var(--db-line)', borderRadius: 9, fontSize: 13, color: 'var(--db-ink)', transition: 'border-color .12s, background .12s' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--db-lava)'; (e.currentTarget as HTMLElement).style.background = 'var(--db-lava-tint)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--db-line)'; (e.currentTarget as HTMLElement).style.background = 'var(--panel-bg)'; }}
          >
            <GenieMark size={15} />
            <span style={{ flex: 1 }}>{s}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" style={{ color: 'var(--db-ink-muted)', flexShrink: 0 }}>
              <path d="M5 12h14M13 6l6 6-6 6"/>
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function GenieSuggestionsTab({ meetingId }: { meetingId: string }) {
  const [hints, setHints] = useState<GenieHint[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!meetingId) { setLoading(false); return; }
    fetch(`http://localhost:5167/api/copilot/hints/${meetingId}`)
      .then(r => r.ok ? r.json() : { hints: [] })
      .then(d => {
        const completed = (d.hints ?? [])
          .filter((h: GenieHint) => (h.genie_status === 'complete' || h.genie_status === 'completed') && h.genie_raw_answer)
          .sort((a: GenieHint, b: GenieHint) => a.timestamp - b.timestamp);
        setHints(completed);
        if (completed.length > 0) setExpandedId(completed[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId) return;
    fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(d => setChatMessages((d.messages ?? []).filter((m: ChatMessage) => m.role === 'user' || m.role === 'genie')))
      .catch(() => {});
  }, [meetingId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chatMessages, chatLoading]);

  const sendChat = useCallback(async (q?: string) => {
    const question = (q ?? chatInput).trim();
    if (!question || chatLoading) return;
    setChatInput('');
    setChatError(null);
    setChatLoading(true);

    try {
      const postR = await fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!postR.ok) { setChatError('Could not send message.'); setChatLoading(false); return; }
      const postD = await postR.json();
      if (postD.status === 'error') { setChatError(postD.detail || 'Error'); setChatLoading(false); return; }

      if (postD.user_message_id) {
        setChatMessages(prev => [...prev, { id: postD.user_message_id, role: 'user', content: question }]);
      }

      const knownIds = new Set(chatMessages.map(m => m.id));
      let polls = 0;
      const intervalId = setInterval(async () => {
        polls++;
        if (polls > 60) { clearInterval(intervalId); setChatError('Genie timed out. Try again.'); setChatLoading(false); return; }
        try {
          const r = await fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`);
          const d = await r.json();
          const msgs: ChatMessage[] = d.messages ?? [];
          const newMsg = msgs.find(m => !knownIds.has(m.id) && (m.role === 'genie' || m.role === 'error'));
          if (!newMsg) return;
          clearInterval(intervalId);
          if (newMsg.role === 'error') {
            const status = newMsg.content.match(/__status:(\w+)__/)?.[1] ?? 'error';
            setChatError(status === 'unavailable' ? 'Genie is unavailable. Check Settings → Genie Live.' : 'Genie timed out. Try again.');
          } else {
            setChatMessages(msgs.filter(m => m.role === 'user' || m.role === 'genie'));
          }
          setChatLoading(false);
        } catch { /* keep polling */ }
      }, 3000);
    } catch {
      setChatError('Network error.');
      setChatLoading(false);
    }
  }, [meetingId, chatInput, chatLoading, chatMessages]);

  const hasSuggestions = hints.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)' }}>
      {/* Suggestions section header */}
      <div
        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--db-line)' }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--db-navy)' }}>Genie suggestions</span>
        {hints.length > 0 && (
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--db-lava)', background: 'var(--db-lava-tint)', borderRadius: 999, padding: '1px 8px' }}>{hints.length}</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--db-ink-muted)' }}>Surfaced during the meeting</span>
      </div>

      {/* Scrollable: suggestions + conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar" style={{ minHeight: 0 }}>

        {/* Suggestions */}
        <div style={{ padding: '14px 18px 6px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--db-ink-muted)', fontSize: 13 }}>Loading…</div>
          ) : !hasSuggestions ? (
            <div style={{ textAlign: 'center', padding: '32px 20px' }}>
              <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--db-lava-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <GenieMark size={24} />
              </div>
              <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--db-navy)', marginBottom: 6 }}>No Genie insights</p>
              <p style={{ fontSize: 13, color: 'var(--db-ink-soft)', lineHeight: 1.5, maxWidth: 280, margin: '0 auto' }}>
                Enable Genie Live before your next recording to capture insights in real time.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {hints.map((hint, i) => (
                <SuggestionCard key={hint.id} hint={hint} index={i + 1}
                  isExpanded={expandedId === hint.id}
                  onToggle={() => setExpandedId(id => id === hint.id ? null : hint.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Conversation section — distinct background, clear label */}
        <div style={{ marginTop: 16, background: 'var(--db-oat)', borderTop: '1px solid var(--db-line)', padding: '14px 18px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, background: 'var(--db-lava-tint)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--db-lava)" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--db-navy)' }}>Continue with Genie</span>
            <span style={{ fontSize: 11, color: 'var(--db-ink-muted)' }}>· your follow-ups, not saved to the record</span>
          </div>

          {chatMessages.length === 0 && !chatLoading ? (
            <ConversationStarters onPick={sendChat} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {chatMessages.map(msg => (
                msg.role === 'user' ? (
                  <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ maxWidth: '84%', background: 'var(--db-navy)', color: '#fff', borderRadius: '14px 14px 4px 14px', padding: '10px 14px', fontSize: 13.5, lineHeight: 1.5 }}>
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div key={msg.id} style={{ display: 'flex', gap: 10 }}>
                    <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 8, background: 'var(--panel-bg)', border: '1px solid var(--db-line)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
                      <GenieMark size={17} />
                    </div>
                    <div style={{ maxWidth: '84%', background: 'var(--panel-bg)', border: '1px solid var(--db-line)', borderRadius: '14px 14px 14px 4px', padding: '11px 14px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--db-ink)' }}>
                      <div className="genie-md text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                    </div>
                  </div>
                )
              ))}
              {chatLoading && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 8, background: 'var(--panel-bg)', border: '1px solid var(--db-line)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <GenieMark size={17} />
                  </div>
                  <div style={{ background: 'var(--panel-bg)', border: '1px solid var(--db-line)', borderRadius: '14px 14px 14px 4px', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[0, 1, 2].map(i => (
                        <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--db-lava)', animation: `liveDot ${0.6 + i * 0.16}s ease-in-out infinite` }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 12.5, color: 'var(--db-ink-muted)' }}>Genie is thinking… this can take up to 90s</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {chatError && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 9, background: 'rgba(255,54,33,0.08)', border: '1px solid rgba(255,54,33,0.2)', fontSize: 12.5, color: '#C02810' }}>
              {chatError}
            </div>
          )}
        </div>
      </div>

      {/* Sticky composer */}
      <div style={{ flexShrink: 0, padding: '10px 18px 14px', borderTop: '1px solid var(--db-line)', background: 'var(--panel-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--db-oat)', border: '1px solid var(--db-line)', borderRadius: 12, padding: '7px 7px 7px 13px' }}>
          <GenieMark size={18} />
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
            placeholder="Ask Genie about this meeting…"
            disabled={chatLoading}
            style={{ all: 'unset', flex: 1, fontSize: 13.5, color: 'var(--db-ink)', padding: '4px 0' }}
          />
          <button
            onClick={() => sendChat()}
            disabled={!chatInput.trim() || chatLoading}
            style={{ all: 'unset', cursor: chatInput.trim() && !chatLoading ? 'pointer' : 'default', width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: chatInput.trim() && !chatLoading ? 'var(--db-lava)' : 'var(--db-oat-medium)', color: '#fff', transition: 'background .14s' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--db-ink-muted)', marginTop: 7 }}>
          Genie answers are grounded in this meeting's transcript and your workspace data
        </p>
      </div>
    </div>
  );
}
