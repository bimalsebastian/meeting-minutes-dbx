'use client';

import { useState, useEffect } from 'react';

interface ConsentDialogProps {
  onDone: () => void;
}

export function ConsentDialog({ onDone }: ConsentDialogProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    fetch('http://localhost:5167/api/telemetry/settings')
      .then(r => r.json())
      .then(d => {
        if (!d.telemetryConsentShown) setVisible(true);
      })
      .catch(() => {});
  }, []);

  const handleChoice = async (enabled: boolean) => {
    try {
      await fetch('http://localhost:5167/api/telemetry/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetryEnabled: enabled,
          telemetryConsentShown: true,
          telemetryPath: '',
        }),
      });
      if (enabled) {
        fetch('http://localhost:5167/api/telemetry/app-opened', { method: 'POST' }).catch(() => {});
      }
    } catch {
      // silent — consent state saved locally even if request fails
    }
    setVisible(false);
    onDone();
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="relative w-full max-w-md rounded-2xl p-8 mx-4"
        style={{
          background: 'var(--panel-bg)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        {/* Icon */}
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-5"
          style={{ background: 'rgba(0,122,255,0.12)' }}
        >
          📊
        </div>

        <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          Help improve Meetily
        </h2>
        <p className="text-sm mb-5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Meetily can share anonymous usage statistics to help understand which features are most useful.
        </p>

        {/* What IS collected */}
        <div className="mb-3 space-y-1.5">
          {[
            'Which features you use',
            'App version',
            'Error types (no message details)',
            'A random install ID — not linked to you',
          ].map(item => (
            <div key={item} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--accent-hex)' }}>✓</span>
              {item}
            </div>
          ))}
        </div>

        {/* What is NEVER collected */}
        <div className="mb-6 space-y-1.5">
          {[
            'Meeting content or transcripts',
            'Your name or contact details',
            'Attendee or company names',
            'Any text from your meetings',
          ].map(item => (
            <div key={item} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span className="text-red-400">✗</span>
              {item}
            </div>
          ))}
        </div>

        {/* Buttons */}
        <div className="flex flex-col gap-2">
          <button
            onClick={() => handleChoice(true)}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent-hex)' }}
          >
            Enable anonymous analytics
          </button>
          <button
            onClick={() => handleChoice(false)}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            style={{ color: 'var(--text-secondary)' }}
          >
            No thanks
          </button>
        </div>

        <p className="text-xs text-center mt-4" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
          You can change this any time in Settings → General → Analytics
        </p>
      </div>
    </div>
  );
}
