'use client';

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface RecallBrief {
  event_id: string;
  event_title: string;
  attendees_json: string;
  brief_text: string;
  triggered_at: string;
}

interface RecallModalProps {
  isOpen: boolean;
  onClose: () => void;
  brief: RecallBrief;
}

export default function RecallModal({ isOpen, onClose, brief }: RecallModalProps) {
  let attendees: string[] = [];
  try {
    attendees = JSON.parse(brief.attendees_json);
  } catch {
    attendees = [];
  }

  const noHistory = brief.brief_text === 'No previous meeting notes found for these attendees.';

  const bulletLines = brief.brief_text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold leading-snug">
            Pre-Meeting Brief: {brief.event_title}
          </DialogTitle>
          {attendees.length > 0 && (
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              Attendees: {attendees.join(', ')}
            </p>
          )}
        </DialogHeader>

        <div className="mt-4">
          {noHistory ? (
            <div className="bg-[var(--panel-elevated)] border border-[var(--separator)] rounded-md p-4 text-sm text-[var(--text-secondary)]">
              No previous meeting notes found for these attendees.
            </div>
          ) : (
            <ul className="space-y-2">
              {bulletLines.map((line, idx) => (
                <li key={idx} className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                  <span className="mt-0.5 text-blue-500 flex-shrink-0">•</span>
                  <span>{line.startsWith('•') ? line.slice(1).trim() : line}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
