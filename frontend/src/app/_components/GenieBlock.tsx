'use client';

import { useEffect, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { parseGenieAnswer } from '@/lib/parseGenieAnswer';

interface GenieHint {
  id: string;
  cycle_number: number;
  extracted_query: string | null;
  genie_raw_answer: string | null;
  genie_status: string;
  timestamp: number;
  created_at: string;
}

function formatSecs(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function GenieMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" style={{ flexShrink: 0 }}>
      <path d="M209 409C192 409 178 426 178 448h146c0-22-14-39-31-39H209Z" fill="var(--coral)" />
      <path d="M460 207C429 257 382 325 362 343c-21 17-52 49-123 49-50 0-93-32-112-78l-1 3c-3-7-9-12-17-12-10 0-18 8-18 18 0 2 0 4 1 6 4 10 16 10 16 42h-1c-30 0-55-25-55-55s25-55 55-55h92c7 0 13 3 17 8 7 9 12 17 16 24 4 6 15 6 19 0 4-7 9-15 15-24 4-5 11-8 18-8h32c47 0 73-23 86-39 7-9 17-14 28-14h24Z" fill="var(--coral-dim)" style={{ fillOpacity: 1 }} />
      <path d="M247 286c0-61-49-111-109-111 60 0 109-50 109-111 0 61 49 111 109 111-60 0-109 50-109 111Z" fill="var(--coral)" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      style={{
        color: 'var(--text-secondary)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s ease',
        flexShrink: 0,
      }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function GenieBlock({ meetingId, fullHeight }: { meetingId: string; fullHeight?: boolean }) {
  const [hints, setHints] = useState<GenieHint[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Inline conversation thread state (fullHeight mode)
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
          .filter((h: GenieHint) =>
            (h.genie_status === 'complete' || h.genie_status === 'completed') &&
            h.genie_raw_answer
          )
          .sort((a: GenieHint, b: GenieHint) => a.timestamp - b.timestamp);
        setHints(completed);
        if (completed.length > 0) setExpandedId(completed[completed.length - 1].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [meetingId]);

  // Load persisted chat messages
  useEffect(() => {
    if (!meetingId || !fullHeight) return;
    fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(d => setChatMessages(d.messages ?? []))
      .catch(() => {});
  }, [meetingId, fullHeight]);

  // Scroll to bottom when chat updates
  useEffect(() => {
    if (!fullHeight) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [chatMessages, chatLoading, fullHeight]);

  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q || chatLoading) return;
    setChatInput('');
    setChatError(null);
    setExpandedId(null);   // collapse open suggestion
    setChatLoading(true);

    try {
      // 1. POST returns immediately — just saves user message and kicks off Genie in background
      const postR = await fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      if (!postR.ok) {
        setChatError('Backend error — could not send message.');
        setChatLoading(false);
        return;
      }
      const postD = await postR.json();
      if (postD.status === 'error') {
        setChatError(`Error: ${postD.detail || 'unknown'}`);
        setChatLoading(false);
        return;
      }

      // Show user message immediately — don't wait for the poll to surface it
      if (postD.user_message_id) {
        setChatMessages(prev => [...prev, {
          id: postD.user_message_id,
          role: 'user' as const,
          content: q,
        }]);
      }

      // 2. Poll every 3s (same mechanism as GenieLiveSidebar hint polling).
      //    Stop when a new genie/error message appears or after 3 min (60 polls).
      //    3 min gives the backend's ~100s Genie poll budget + API overhead.
      const knownIds = new Set(chatMessages.map(m => m.id));
      if (postD.user_message_id) knownIds.delete(postD.user_message_id); // don't treat our optimistic msg as "known"
      let polls = 0;
      const MAX_POLLS = 60;  // 60 × 3s = 3 min

      console.log(`[genie-chat] starting poll — knownIds: ${knownIds.size}, MAX_POLLS: ${MAX_POLLS}`);

      const intervalId = setInterval(async () => {
        polls++;
        if (polls > MAX_POLLS) {
          clearInterval(intervalId);
          console.warn(`[genie-chat] TIMEOUT after ${polls} polls (${polls * 3}s)`);
          setChatError('Genie timed out after 3 minutes. Try again.');
          setChatLoading(false);
          return;
        }
        try {
          const r = await fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`);
          const d = await r.json();
          const messages: ChatMessage[] = d.messages ?? [];
          console.log(`[genie-chat] poll ${polls}: ${messages.length} messages, roles: [${messages.map(m=>m.role).join(',')}]`);

          const newMsg = messages.find(
            m => !knownIds.has(m.id) && (m.role === 'genie' || m.role === 'error')
          );
          if (!newMsg) {
            console.log(`[genie-chat] poll ${polls}: no new genie/error message yet`);
            return;
          }

          clearInterval(intervalId);
          console.log(`[genie-chat] poll ${polls}: found new ${newMsg.role} message — stopping poll`);

          if (newMsg.role === 'error') {
            const status = newMsg.content.match(/__status:(\w+)__/)?.[1] ?? 'error';
            setChatError(
              status === 'unavailable'
                ? 'Genie is unavailable — check Settings → Genie Live workspace configuration.'
                : status === 'timeout'
                  ? 'Genie timed out. Try again in a moment.'
                  : 'Genie could not answer. Try rephrasing.'
            );
          } else {
            setChatMessages(messages.filter(m => m.role === 'user' || m.role === 'genie'));
          }
          setChatLoading(false);
        } catch { /* transient — keep polling */ }
      }, 3000);

    } catch {
      setChatError('Network error — is the backend running?');
      setChatLoading(false);
    }
  };

  if (loading) return fullHeight ? (
    <div className="h-full flex items-center justify-center" style={{ color: 'var(--text-secondary)' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="animate-spin mr-2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>
  ) : null;

  // Card mode (summary column) — existing card layout
  const cardContent = (
    <>
      <button onClick={() => setPanelOpen(v => !v)}
        className="flex items-center gap-2 px-4 py-3 w-full text-left transition-colors"
        style={{ background: 'none', border: 'none', cursor: 'pointer', borderBottom: panelOpen ? '1px solid var(--separator)' : 'none' }}>
        <GenieMark />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>Genie Suggestions</span>
        {hints.length > 0 && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--coral-dim)', color: 'var(--coral)' }}>{hints.length}</span>
        )}
        <div style={{ flex: 1 }} />
        <Chevron open={panelOpen} />
      </button>
      {panelOpen && (
        <div className="p-3 overflow-y-auto custom-scrollbar" style={{ maxHeight: 420 }}>
          {hints.length === 0 ? (
            <div className="rounded-xl px-5 py-8 text-center" style={{ border: '1.5px dashed var(--separator-strong)' }}>
              <div className="flex justify-center mb-3" style={{ color: 'var(--text-tertiary)' }}><GenieMark size={24} /></div>
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No Genie insights</p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)', maxWidth: 320, margin: '0 auto' }}>
                Genie didn't surface any insights during this meeting.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {hints.map((hint, i) => (
                <GenieCard key={hint.id} hint={hint} index={i + 1}
                  isExpanded={expandedId === hint.id}
                  onToggle={() => setExpandedId(id => id === hint.id ? null : hint.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );

  if (!fullHeight) {
    return (
      <div style={{ background: 'var(--panel-bg)', border: '1px solid var(--separator)', borderRadius: 12, overflow: 'hidden' }}>
        {cardContent}
      </div>
    );
  }

  // ── Full-height mode: single scrollable column, inline chat, sticky input ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--panel-bg)' }}>

      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: '1px solid var(--separator)' }}>
        <GenieMark />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          Genie Suggestions
        </span>
        {hints.length > 0 && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: 'var(--coral-dim)', color: 'var(--coral)' }}>{hints.length}</span>
        )}
        {chatMessages.length > 0 && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full ml-1"
            style={{ background: 'rgba(10,132,255,0.12)', color: 'var(--accent-hex)' }}>
            {chatMessages.length} follow-up{chatMessages.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Scrollable: suggestions + inline conversation thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar" style={{ minHeight: 0, padding: '12px 12px 8px' }}>

        {/* Suggestion cards */}
        {hints.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div style={{ color: 'var(--text-tertiary)', marginBottom: 12 }}><GenieMark size={28} /></div>
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No Genie insights yet</p>
            <p className="text-xs text-center leading-relaxed" style={{ color: 'var(--text-secondary)', maxWidth: 260 }}>
              Suggestions will appear here when Genie Live is enabled during recording.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {hints.map((hint, i) => (
              <GenieCard key={hint.id} hint={hint} index={i + 1}
                isExpanded={expandedId === hint.id}
                onToggle={() => setExpandedId(id => id === hint.id ? null : hint.id)} />
            ))}
          </div>
        )}

        {/* Seamless conversation thread — flows below suggestions */}
        {(chatMessages.length > 0 || chatLoading) && (
          <div className="mt-4">
            {/* Thread separator */}
            <div className="flex items-center gap-2 mb-3">
              <div style={{ flex: 1, height: 1, background: 'var(--separator)' }} />
              <span className="text-xs font-semibold flex items-center gap-1.5"
                style={{ color: 'var(--accent-hex)', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Conversation
              </span>
              <div style={{ flex: 1, height: 1, background: 'var(--separator)' }} />
            </div>

            {/* Messages */}
            <div className="flex flex-col gap-2">
              {chatMessages.map(msg => (
                <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                  {msg.role === 'genie' && <div className="flex-shrink-0 mt-0.5"><GenieMark size={14} /></div>}
                  <div className="text-xs leading-snug rounded-xl px-2.5 py-2 max-w-[88%]"
                    style={msg.role === 'user' ? {
                      background: 'rgba(10,132,255,0.12)',
                      border: '1px solid rgba(10,132,255,0.2)',
                      color: 'var(--text-primary)',
                    } : {
                      background: 'var(--panel-elevated)',
                      border: '1px solid var(--separator)',
                      color: 'var(--text-primary)',
                    }}>
                    {msg.role === 'genie'
                      ? <div className="genie-md text-xs"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                      : msg.content}
                  </div>
                </div>
              ))}

              {/* Thinking dots */}
              {chatLoading && (
                <div className="flex gap-2 items-center">
                  <GenieMark size={14} />
                  <div className="flex gap-1 px-3 py-2 rounded-xl"
                    style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)' }}>
                    {[0,1,2].map(i => (
                      <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--coral)',
                        animation: `liveDot ${0.6 + i * 0.15}s ease-in-out infinite` }} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {chatError && (
          <div className="mt-3 px-3 py-2 rounded-lg text-xs"
            style={{ background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.2)', color: '#FF453A' }}>
            {chatError}
          </div>
        )}
      </div>

      {/* Sticky input — always at the bottom */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-3"
        style={{ borderTop: '1px solid var(--separator)', background: 'var(--panel-bg)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          style={{ color: 'var(--accent-hex)', flexShrink: 0 }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <input
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
          placeholder="Ask a follow-up…"
          disabled={chatLoading}
          className="flex-1 text-xs rounded-lg px-3 py-2 focus:outline-none disabled:opacity-50"
          style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)', color: 'var(--text-primary)' }}
        />
        <button onClick={sendChat} disabled={!chatInput.trim() || chatLoading}
          className="flex-shrink-0 flex items-center justify-center rounded-lg w-8 h-8 transition-opacity disabled:opacity-30"
          style={{ background: 'var(--accent-hex)', border: 'none', cursor: 'pointer', color: '#fff' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>

    </div>
  );
}

async function openUrl(url: string) {
  try { await invoke('open_external_url', { url }); }
  catch { window.open(url, '_blank'); }
}

function GenieCard({ hint, index, isExpanded, onToggle }: {
  hint: GenieHint;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const parsed = parseGenieAnswer(hint.genie_raw_answer);
  const { quickLinks, nextSteps, hasStructuredContent } = parsed;

  const badges = [
    quickLinks.length > 0 && `${quickLinks.length} link${quickLinks.length > 1 ? 's' : ''}`,
    nextSteps.length > 0 && `${nextSteps.length} step${nextSteps.length > 1 ? 's' : ''}`,
  ].filter(Boolean);

  return (
    <div className="rounded-xl overflow-hidden transition-all duration-150"
      style={{ background: 'var(--panel-elevated)', boxShadow: isExpanded ? '0 0 0 1px var(--coral-dim), 0 4px 12px rgba(0,0,0,0.1)' : '0 0 0 1px rgba(0,0,0,0.06)' }}>
      <button onClick={onToggle} className="flex items-center gap-2 px-3 py-2.5 w-full text-left"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
        <span className="flex-shrink-0 text-xs font-bold px-1.5 py-0.5 rounded-md"
          style={{ background: 'var(--coral-dim)', color: 'var(--coral)', minWidth: 20, textAlign: 'center' }}>{index}</span>
        <GenieMark size={13} />
        <span className="text-xs font-bold uppercase tracking-wider flex-1 min-w-0"
          style={{ color: 'var(--coral)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hint.extracted_query ?? `Check ${hint.cycle_number}`}
        </span>
        {!isExpanded && badges.length > 0 && (
          <span className="text-xs flex-shrink-0 px-1.5 py-0.5 rounded-md"
            style={{ background: 'var(--coral-dim)', color: 'var(--coral)', fontSize: '10px' }}>{badges.join(' · ')}</span>
        )}
        {hint.timestamp > 0 && (
          <span className="text-xs font-mono flex-shrink-0" style={{ color: 'var(--text-tertiary)', fontSize: '10px' }}>{formatSecs(hint.timestamp)}</span>
        )}
        <Chevron open={isExpanded} />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3" style={{ borderTop: '1px solid var(--separator)' }}>
          {hasStructuredContent && !showFull ? (
            <>
              {quickLinks.length > 0 && (
                <div className="mt-2.5 mb-3">
                  <p className="text-xs font-semibold mb-1.5 flex items-center gap-1"
                    style={{ color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>Quick Links
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {quickLinks.map((link, i) => (
                      <button key={i} onClick={() => openUrl(link.url)} className="text-left rounded-lg px-2.5 py-2 w-full"
                        style={{ background: 'rgba(10,132,255,0.07)', border: '1px solid rgba(10,132,255,0.18)', cursor: 'pointer' }}>
                        <span className="text-xs font-semibold block" style={{ color: 'var(--accent-hex)' }}>{link.text}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'inline', marginLeft: 4 }}>
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </span>
                        {link.description && <span className="text-xs mt-0.5 block" style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>{link.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {nextSteps.length > 0 && (
                <div className={quickLinks.length > 0 ? 'pt-2.5' : 'mt-2.5'} style={quickLinks.length > 0 ? { borderTop: '1px solid var(--separator)' } : {}}>
                  <p className="text-xs font-semibold mb-1.5 flex items-center gap-1"
                    style={{ color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                    </svg>Suggested Next Steps
                  </p>
                  <ol className="flex flex-col gap-1.5" style={{ paddingLeft: 0, listStyle: 'none' }}>
                    {nextSteps.map((step, i) => (
                      <li key={i} className="flex gap-2 items-start">
                        <span className="flex-shrink-0 text-xs font-bold w-4 h-4 rounded-full flex items-center justify-center mt-0.5"
                          style={{ background: 'var(--coral-dim)', color: 'var(--coral)', fontSize: '10px' }}>{i + 1}</span>
                        <span className="text-xs leading-snug flex-1" style={{ color: 'var(--text-primary)' }}>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <button onClick={() => setShowFull(true)} className="mt-3 text-xs transition-opacity hover:opacity-70"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0 }}>
                Show full Genie answer ↓
              </button>
            </>
          ) : (
            <>
              <div className="text-sm leading-snug genie-md pt-2" style={{ color: 'var(--text-primary)' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{hint.genie_raw_answer ?? ''}</ReactMarkdown>
              </div>
              {hasStructuredContent && (
                <button onClick={() => setShowFull(false)} className="mt-2 text-xs transition-opacity hover:opacity-70"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0 }}>
                  Show structured view ↑
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Meeting-level Genie chat panel ────────────────────────────────────────────

interface ChatMessage { id: string; role: 'user' | 'genie' | 'error'; content: string; }

function MeetingChatPanel({ meetingId }: { meetingId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load persisted messages
  useEffect(() => {
    if (!meetingId) return;
    fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(d => setMessages(d.messages ?? []))
      .catch(() => {});
  }, [meetingId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput('');
    setError(null);
    setLoading(true);

    const tmp: ChatMessage = { id: `tmp-${Date.now()}`, role: 'user', content: q };
    setMessages(prev => [...prev, tmp]);

    try {
      const r = await fetch(`http://localhost:5167/api/meetings/${meetingId}/genie-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const d = await r.json();
      if (d.status === 'complete' && d.answer) {
        setMessages(prev => [...prev.filter(m => m.id !== tmp.id),
          { id: tmp.id + '-u', role: 'user', content: q },
          { id: tmp.id + '-g', role: 'genie', content: d.answer }]);
      } else {
        setError(d.status === 'unavailable'
          ? 'Genie is unavailable — check Settings → Genie Live to ensure your workspace is configured.'
          : 'Genie timed out. Try again in a moment.');
        setMessages(prev => prev.filter(m => m.id !== tmp.id));
      }
    } catch {
      setError('Could not reach the backend. Is it running?');
      setMessages(prev => prev.filter(m => m.id !== tmp.id));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full" style={{ borderTop: '1px solid var(--separator)' }}>
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--separator)', background: 'var(--panel-bg)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          style={{ color: 'var(--accent-hex)', flexShrink: 0 }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span className="text-xs font-semibold" style={{ color: 'var(--accent-hex)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Continue conversation
        </span>
        {messages.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-md ml-1"
            style={{ background: 'rgba(10,132,255,0.1)', color: 'var(--accent-hex)', fontSize: '10px' }}>{messages.length}</span>
        )}
        <p className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>Continues from your meeting's Genie context</p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3" style={{ minHeight: 0 }}>
        {messages.length === 0 && !loading && (
          <p className="text-xs text-center mt-4" style={{ color: 'var(--text-tertiary)' }}>
            Ask a follow-up question — Genie will answer with context from this meeting's conversation thread.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {messages.map(msg => (
            <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              {msg.role === 'genie' && <div className="flex-shrink-0 mt-0.5"><GenieMark size={14} /></div>}
              <div className="text-xs leading-snug rounded-xl px-2.5 py-2 max-w-[88%]"
                style={msg.role === 'user' ? {
                  background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(10,132,255,0.2)', color: 'var(--text-primary)',
                } : {
                  background: 'var(--panel-elevated)', border: '1px solid var(--separator)', color: 'var(--text-primary)',
                }}>
                {msg.role === 'genie'
                  ? <div className="genie-md text-xs"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                  : msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex gap-2 items-center">
              <GenieMark size={14} />
              <div className="flex gap-1 px-3 py-2 rounded-xl" style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)' }}>
                {[0,1,2].map(i => (
                  <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--coral)', animation: `liveDot ${0.6 + i*0.15}s ease-in-out infinite` }} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 mx-3 mb-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.2)', color: '#FF453A' }}>
          {error}
        </div>
      )}

      {/* Input */}
      <div className="flex-shrink-0 flex gap-2 px-3 pb-3 pt-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask a follow-up about this meeting…"
          disabled={loading}
          className="flex-1 text-xs rounded-lg px-3 py-2 focus:outline-none disabled:opacity-50"
          style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)', color: 'var(--text-primary)' }}
        />
        <button onClick={send} disabled={!input.trim() || loading}
          className="flex-shrink-0 flex items-center justify-center rounded-lg w-8 h-8 transition-opacity disabled:opacity-30"
          style={{ background: 'var(--accent-hex)', border: 'none', cursor: 'pointer', color: '#fff' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
