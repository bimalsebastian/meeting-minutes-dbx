'use client';

import { useState } from 'react';
import { useRecallBriefs } from '../../hooks/useRecallBriefs';
import RecallModal from './RecallModal';

interface RecallBrief {
  event_id: string;
  event_title: string;
  attendees_json: string;
  brief_text: string;
  triggered_at: string;
}

export default function RecallBanner() {
  const { briefs, recallEnabled } = useRecallBriefs();
  const [modalBrief, setModalBrief] = useState<RecallBrief | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  if (!recallEnabled || briefs.length === 0) return null;

  const brief = briefs.find((b) => !dismissed.has(b.event_id));
  if (!brief) return null;

  const handleDismiss = () => {
    localStorage.setItem(`recall_dismissed_${brief.event_id}`, 'true');
    setDismissed((prev) => new Set([...prev, brief.event_id]));
    fetch(`http://localhost:5167/api/recall/brief/${brief.event_id}/dismiss`, { method: 'POST' }).catch(() => {});
  };

  // Parse attendees for display
  let attendees: string[] = [];
  try {
    attendees = JSON.parse(brief.attendees_json);
  } catch {
    attendees = [];
  }
  const displayAttendees =
    attendees
      .slice(0, 3)
      .map((e) => e.split('@')[0])
      .join(', ') + (attendees.length > 3 ? ` +${attendees.length - 3}` : '');

  return (
    <>
      <div className="fixed top-0 left-0 right-0 z-50 bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center justify-between text-sm">
        <span className="text-blue-800">
          <strong>Upcoming:</strong> {brief.event_title} in ~15 min
          {displayAttendees && ` — ${displayAttendees}`}
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setModalBrief(brief)}
            className="text-blue-700 underline text-xs hover:text-blue-900"
          >
            View pre-meeting brief →
          </button>
          <button
            onClick={handleDismiss}
            className="text-blue-400 hover:text-blue-600 text-lg leading-none"
          >
            ×
          </button>
        </div>
      </div>
      {modalBrief && (
        <RecallModal
          isOpen={true}
          onClose={() => setModalBrief(null)}
          brief={modalBrief}
        />
      )}
    </>
  );
}
