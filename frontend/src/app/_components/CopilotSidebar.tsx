'use client';

import { useState, useEffect } from 'react';

interface CopilotHint {
  id: string;
  meeting_id: string;
  created_at: string;
  topic_detected: string;
  talking_points: string[];
  genie_used: boolean;
  genie_answer?: string | null;
}

interface CopilotSidebarProps {
  meetingId: string | null;
  isRecording: boolean;
  isEnabled: boolean;
}

export default function CopilotSidebar({ meetingId, isRecording, isEnabled }: CopilotSidebarProps) {
  const [hints, setHints] = useState<CopilotHint[]>([]);

  // Crash recovery: reset backend state on mount
  useEffect(() => {
    fetch('http://localhost:5167/api/copilot/recording-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop', meeting_id: '' }),
    }).catch(() => {});
  }, []);

  // Signal recording start/stop to backend
  useEffect(() => {
    if (!meetingId) return;
    fetch('http://localhost:5167/api/copilot/recording-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: isRecording ? 'start' : 'stop', meeting_id: meetingId }),
    }).catch(() => {});
  }, [isRecording, meetingId]);

  // Poll for hints while recording
  useEffect(() => {
    if (!isEnabled || !isRecording || !meetingId) return;
    const poll = async () => {
      try {
        const r = await fetch(`http://localhost:5167/api/copilot/hints/${meetingId}`);
        const d = await r.json();
        setHints(d.hints ?? []);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, [isEnabled, isRecording, meetingId]);

  if (!isEnabled) {
    return (
      <div className="w-72 flex-shrink-0 border-l border-gray-200 bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <p className="text-sm font-medium text-gray-500">Co-pilot disabled</p>
        <p className="text-xs text-gray-400 mt-1">Enable in Settings &rarr; Co-pilot</p>
      </div>
    );
  }

  if (!isRecording) {
    return (
      <div className="w-72 flex-shrink-0 border-l border-gray-200 bg-white p-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">SA Co-pilot</h3>
        <p className="text-xs text-gray-400">Co-pilot hints appear here during recording.</p>
      </div>
    );
  }

  return (
    <div className="w-72 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto p-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-3">SA Co-pilot</h3>
      {hints.length === 0 && (
        <p className="text-xs text-gray-400">Waiting for first analysis...</p>
      )}
      {hints.map(hint => (
        <HintCard key={hint.id} hint={hint} />
      ))}
    </div>
  );
}

function HintCard({ hint }: { hint: CopilotHint }) {
  const time = new Date(hint.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="mb-3 rounded-lg border border-gray-200 p-3 border-l-4 border-l-red-500">
      <p className="text-xs font-semibold text-gray-800 mb-2">{hint.topic_detected}</p>
      <ul className="space-y-1">
        {hint.talking_points.map((pt, i) => (
          <li key={i} className="text-xs text-gray-600 flex gap-1">
            <span className="text-red-400 flex-shrink-0">&bull;</span>
            <span>{pt}</span>
          </li>
        ))}
      </ul>
      {hint.genie_used && hint.genie_answer && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <span className="inline-flex items-center gap-1 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full mb-1">
            &#10022; Grounded by Genie
          </span>
          <p className="text-xs text-gray-600 italic">{hint.genie_answer}</p>
        </div>
      )}
      <p className="text-xs text-gray-400 text-right mt-1">{time}</p>
    </div>
  );
}
