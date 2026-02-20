import { useState, useCallback, useRef, useEffect } from 'react';
import { Transcript, Summary } from '@/types';
import { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { CurrentMeeting, useSidebar } from '@/components/Sidebar/SidebarProvider';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { renameObsidianNote, syncMeetingToObsidian } from '@/lib/obsidian-formatter';
import { secureRetrieve } from '@/lib/stronghold';
import { ModelConfig } from '@/components/ModelSettingsModal';

interface UseMeetingDataProps {
  meeting: any;
  summaryData: Summary | null;
  onMeetingUpdated?: () => Promise<void>;
  modelConfig: ModelConfig; // Add modelConfig for Obsidian sync
}

export function useMeetingData({ meeting, summaryData, onMeetingUpdated, modelConfig }: UseMeetingDataProps) {
  // State
  // Use prop directly since summary generation fetches transcripts independently
  const transcripts = meeting.transcripts;
  const [meetingTitle, setMeetingTitle] = useState(meeting.title || '+ New Call');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isTitleDirty, setIsTitleDirty] = useState(false);
  const [aiSummary, setAiSummary] = useState<Summary | null>(summaryData);
  const [isSaving, setIsSaving] = useState(false);
  const [, setIsSummaryDirty] = useState(false);
  const [, setError] = useState<string>('');

  // Ref for BlockNoteSummaryView
  const blockNoteSummaryRef = useRef<BlockNoteSummaryViewRef>(null);

  // Sidebar context
  const { setCurrentMeeting, setMeetings, meetings: sidebarMeetings } = useSidebar();

  // Sync aiSummary state when summaryData prop changes (fixes display of fetched summaries)
  useEffect(() => {
    console.log('[useMeetingData] Syncing summary data from prop:', summaryData ? 'present' : 'null');
    setAiSummary(summaryData);
  }, [summaryData]); // Only trigger when parent prop changes, not when aiSummary changes

  // Handlers
  const handleTitleChange = useCallback((newTitle: string) => {
    setMeetingTitle(newTitle);
    setIsTitleDirty(true);
  }, []);

  const handleSummaryChange = useCallback((newSummary: Summary) => {
    setAiSummary(newSummary);
  }, []);

  const handleSaveMeetingTitle = useCallback(async () => {
    // Capture old title BEFORE save for Obsidian rename
    let oldTitle: string | null = null;
    try {
      const existing = await invokeTauri<{ title: string }>('api_get_meeting', {
        meetingId: meeting.id,
      });
      oldTitle = existing?.title?.trim() || null;
      console.log('[Obsidian] Old title captured:', oldTitle);
    } catch (e) {
      console.warn('[Obsidian] Could not capture old title:', e);
    }

    try {
      await invokeTauri('api_save_meeting_title', {
        meetingId: meeting.id,
        title: meetingTitle,
      });

      console.log('Save meeting title success');
      setIsTitleDirty(false);

      // Update meetings with new title
      const updatedMeetings = sidebarMeetings.map((m: CurrentMeeting) =>
        m.id === meeting.id ? { id: m.id, title: meetingTitle } : m
      );
      setMeetings(updatedMeetings);
      setCurrentMeeting({ id: meeting.id, title: meetingTitle });

      // Rename Obsidian note if vault is configured
      try {
        const vaultPath = (await secureRetrieve('obsidian_vault_path'))?.trim()
          || modelConfig.obsidianVaultPath?.trim()
          || '';
        
        if (vaultPath && oldTitle && oldTitle !== meetingTitle.trim()) {
          const meetingDate = meeting.created_at
            ? new Date(meeting.created_at).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];
          
          await renameObsidianNote({
            vaultPath,
            meetingDate,
            oldTitle,
            newTitle: meetingTitle.trim(),
          });
          console.log('[Obsidian] Renamed vault file after title change');
        }
      } catch (obsidianErr) {
        console.error('[Obsidian] Rename failed (non-fatal):', obsidianErr);
        // Non-fatal: don't block title save
      }

      return true;
    } catch (error) {
      console.error('Failed to save meeting title:', error);
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError('Failed to save meeting title: Unknown error');
      }
      return false;
    }
  }, [meeting.id, meeting.created_at, meetingTitle, sidebarMeetings, setMeetings, setCurrentMeeting, modelConfig]);

  const handleSaveSummary = useCallback(async (summary: Summary | { markdown?: string; summary_json?: any[] }) => {
    console.log('📄 handleSaveSummary called with:', {
      hasMarkdown: 'markdown' in summary,
      hasSummaryJson: 'summary_json' in summary,
      summaryKeys: Object.keys(summary)
    });

    try {
      let formattedSummary: any;

      // Check if it's the new BlockNote format
      if ('markdown' in summary || 'summary_json' in summary) {
        console.log('📄 Saving new format (markdown/blocknote)');
        formattedSummary = summary;
      } else {
        console.log('📄 Saving legacy format');
        formattedSummary = {
          MeetingName: meetingTitle,
          MeetingNotes: {
            sections: Object.entries(summary).map(([, section]) => ({
              title: section.title,
              blocks: section.blocks
            }))
          }
        };
      }

      await invokeTauri('api_save_meeting_summary', {
        meetingId: meeting.id,
        summary: formattedSummary,
      });

      // Keep local state in sync so Obsidian and UI see the saved content
      setAiSummary(formattedSummary as Summary);

      console.log('✅ Save meeting summary success');
    } catch (error) {
      console.error('❌ Failed to save meeting summary:', error);
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError('Failed to save meeting summary: Unknown error');
      }
    }
  }, [meeting.id, meetingTitle]);

  const saveAllChanges = useCallback(async () => {
    setIsSaving(true);
    try {
      // Save meeting title only if changed
      if (isTitleDirty) {
        await handleSaveMeetingTitle();
      }

      // Save BlockNote editor changes if dirty, or persist current aiSummary
      let savedSummaryContent: string | null = null;
      if (blockNoteSummaryRef.current?.isDirty) {
        console.log('💾 Saving BlockNote editor changes...');
        const savedMarkdown = await blockNoteSummaryRef.current.saveSummary();
        savedSummaryContent = savedMarkdown?.trim() || null;
      } else if (aiSummary) {
        await handleSaveSummary(aiSummary);
        if ('markdown' in aiSummary && typeof aiSummary.markdown === 'string') {
          savedSummaryContent = aiSummary.markdown;
        } else if ('summary_json' in aiSummary && aiSummary.summary_json) {
          savedSummaryContent = JSON.stringify(aiSummary.summary_json, null, 2);
        } else {
          savedSummaryContent = JSON.stringify(aiSummary, null, 2);
        }
      }

      // Sync to Obsidian: use content we just saved, or fetch from backend so vault always gets persisted content
      try {
        const vaultPath = (await secureRetrieve('obsidian_vault_path'))?.trim()
          || modelConfig.obsidianVaultPath?.trim()
          || '';
        
        if (vaultPath) {
          let contentForVault = savedSummaryContent;
          if (!contentForVault?.trim()) {
            try {
              const res = await invokeTauri<{ data?: { markdown?: string; summary_json?: unknown } }>('api_get_summary', { meetingId: meeting.id });
              const data = res?.data;
              if (data?.markdown) contentForVault = data.markdown;
              else if (data?.summary_json) contentForVault = JSON.stringify(data.summary_json, null, 2);
              else if (data) contentForVault = JSON.stringify(data, null, 2);
            } catch (e) {
              console.warn('[Obsidian] Could not fetch summary for sync:', e);
            }
          }
          if (contentForVault?.trim()) {
            const token = (await secureRetrieve('databricks_token')) || '';
            const meetingDate = meeting.created_at
              ? new Date(meeting.created_at).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];
            const meetingTitle = meeting.title || `Meeting ${meetingDate}`;
            await syncMeetingToObsidian({
              meetingTitle,
              meetingDate,
              duration: 'Unknown',
              summaryText: contentForVault,
              modelConfig,
              token,
              vaultPath,
            });
            console.log('[Obsidian] Save sync complete');
          }
        }
      } catch (obsidianErr) {
        console.error('[Obsidian] Save sync failed (non-fatal):', obsidianErr);
      }

      toast.success("Changes saved successfully");
    } catch (error) {
      console.error('Failed to save changes:', error);
      toast.error("Failed to save changes", { description: String(error) });
    } finally {
      setIsSaving(false);
    }
  }, [isTitleDirty, handleSaveMeetingTitle, aiSummary, handleSaveSummary, meeting, modelConfig]);

  // Update meeting title from external source (e.g., AI summary)
  const updateMeetingTitle = useCallback((newTitle: string) => {
    console.log('📝 Updating meeting title to:', newTitle);
    setMeetingTitle(newTitle);
    const updatedMeetings = sidebarMeetings.map((m: CurrentMeeting) =>
      m.id === meeting.id ? { id: m.id, title: newTitle } : m
    );
    setMeetings(updatedMeetings);
    setCurrentMeeting({ id: meeting.id, title: newTitle });
  }, [meeting.id, sidebarMeetings, setMeetings, setCurrentMeeting]);

  return {
    // State
    transcripts,
    meetingTitle,
    isEditingTitle,
    isTitleDirty,
    aiSummary,
    isSaving,
    blockNoteSummaryRef,

    // Setters
    setMeetingTitle,
    setIsEditingTitle,
    setAiSummary,
    setIsSummaryDirty,

    // Handlers
    handleTitleChange,
    handleSummaryChange,
    handleSaveSummary,
    handleSaveMeetingTitle,
    saveAllChanges,
    updateMeetingTitle,
  };
}
