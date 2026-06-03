import { useState, useEffect } from 'react';

interface RecallBrief {
  event_id: string;
  event_title: string;
  attendees_json: string;
  brief_text: string;
  triggered_at: string;
}

interface UseRecallBriefsReturn {
  briefs: RecallBrief[];
  recallEnabled: boolean;
  isLoading: boolean;
}

export function useRecallBriefs(): UseRecallBriefsReturn {
  const [briefs, setBriefs] = useState<RecallBrief[]>([]);
  const [recallEnabled, setRecallEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const fetchBriefs = async () => {
    try {
      const r = await fetch('http://localhost:5167/api/recall/upcoming');
      const d = await r.json();
      setRecallEnabled(d.recall_enabled ?? true);
      // Filter dismissed events using localStorage
      const nonDismissed = (d.briefs ?? []).filter(
        (b: RecallBrief) => !localStorage.getItem(`recall_dismissed_${b.event_id}`)
      );
      setBriefs(nonDismissed);
    } catch {
      // Silently fail - backend may not be running
    }
  };

  useEffect(() => {
    fetchBriefs();
    const id = setInterval(fetchBriefs, 60000);
    return () => clearInterval(id);
  }, []);

  return { briefs, recallEnabled, isLoading };
}
