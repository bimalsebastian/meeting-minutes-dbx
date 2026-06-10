"use client";

import { Summary, SummaryResponse, Transcript } from '@/types';
import { EditableTitle } from '@/components/EditableTitle';
import { BlockNoteSummaryView, BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { EmptyStateSummary } from '@/components/EmptyStateSummary';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { SummaryGeneratorButtonGroup } from './SummaryGeneratorButtonGroup';
import { SummaryUpdaterButtonGroup } from './SummaryUpdaterButtonGroup';
import Analytics from '@/lib/analytics';
import { RefObject, useState, useEffect } from 'react';
import { secureRetrieve } from '@/lib/stronghold';

interface SummaryPanelProps {
  meeting: {
    id: string;
    title: string;
    created_at: string;
  };
  meetingTitle: string;
  onTitleChange: (title: string) => void;
  isEditingTitle: boolean;
  onStartEditTitle: () => void;
  onFinishEditTitle: () => void;
  isTitleDirty: boolean;
  summaryRef: RefObject<BlockNoteSummaryViewRef>;
  isSaving: boolean;
  onSaveAll: () => Promise<void>;
  onCopySummary: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  aiSummary: Summary | null;
  summaryStatus: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  transcripts: Transcript[];
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  onGenerateSummary: (customPrompt: string) => Promise<void>;
  onStopGeneration: () => void;
  customPrompt: string;
  summaryResponse: SummaryResponse | null;
  onSaveSummary: (summary: Summary | { markdown?: string; summary_json?: any[] }) => Promise<void>;
  onSummaryChange: (summary: Summary) => void;
  onDirtyChange: (isDirty: boolean) => void;
  summaryError: string | null;
  onRegenerateSummary: () => Promise<void>;
  getSummaryStatusMessage: (status: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error') => string;
  availableTemplates: Array<{ id: string, name: string, description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (templateId: string, templateName: string) => void;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (openFn: () => void) => void;
}

export function SummaryPanel({
  meeting,
  meetingTitle,
  onTitleChange,
  isEditingTitle,
  onStartEditTitle,
  onFinishEditTitle,
  isTitleDirty,
  summaryRef,
  isSaving,
  onSaveAll,
  onCopySummary,
  onOpenFolder,
  aiSummary,
  summaryStatus,
  transcripts,
  modelConfig,
  setModelConfig,
  onSaveModelConfig,
  onGenerateSummary,
  onStopGeneration,
  customPrompt,
  summaryResponse,
  onSaveSummary,
  onSummaryChange,
  onDirtyChange,
  summaryError,
  onRegenerateSummary,
  getSummaryStatusMessage,
  availableTemplates,
  selectedTemplate,
  onTemplateSelect,
  isModelConfigLoading = false,
  onOpenModelSettings
}: SummaryPanelProps) {
  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  // ── Databricks auth detection ────────────────────────────────────────────
  const isDatabricks = modelConfig.provider === 'databricks';
  const [databricksBaseUrl, setDatabricksBaseUrl] = useState('');
  const [cliProfile, setCliProfile] = useState<string | null>(null);

  useEffect(() => {
    if (!isDatabricks) return;
    secureRetrieve('databricks_base_url').then(u => setDatabricksBaseUrl(u?.trim() || '')).catch(() => {});
    secureRetrieve('databricks_cli_profile').then(p => setCliProfile(p?.trim() || null)).catch(() => {});
  }, [isDatabricks]);

  // Only show the banner reactively — after a generation attempt fails.
  // Proactive checks were causing false positives because Stronghold reads
  // are async and the URL appears missing briefly on mount.
  const authFailed = isDatabricks && !!summaryError &&
    /auth|sign.in|token|expired|401|credential|login|workspace|url|endpoint|configure/i.test(summaryError);

  const showAuthBanner = authFailed;

  // The CLI command the user needs to run
  const authCommand = cliProfile
    ? `databricks auth login --profile ${cliProfile}`
    : 'az login';

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">

      {/* ── Databricks auth / config banner ── */}
      {showAuthBanner && (
        <DatabricksAuthBanner
          noWorkspace={false}
          noEndpoint={false}
          authFailed={authFailed}
          authCommand={authCommand}
          cliProfile={cliProfile}
          onOpenSettings={onOpenModelSettings}
        />
      )}

      {/* Button groups — only rendered when summary exists and not loading */}
      {aiSummary && !isSummaryLoading && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 flex-shrink-0"
             style={{ borderBottom: '1px solid var(--separator)' }}>
          <div className="flex-shrink-0">
            <SummaryGeneratorButtonGroup
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
              onSaveModelConfig={onSaveModelConfig}
              onGenerateSummary={onGenerateSummary}
              onStopGeneration={onStopGeneration}
              customPrompt={customPrompt}
              summaryStatus={summaryStatus}
              availableTemplates={availableTemplates}
              selectedTemplate={selectedTemplate}
              onTemplateSelect={onTemplateSelect}
              hasTranscripts={transcripts.length > 0}
              isModelConfigLoading={isModelConfigLoading}
              onOpenModelSettings={onOpenModelSettings}
            />
          </div>
          <div className="flex-shrink-0">
            <SummaryUpdaterButtonGroup
              isSaving={isSaving}
              isDirty={isTitleDirty || (summaryRef.current?.isDirty || false)}
              onSave={onSaveAll}
              onCopy={onCopySummary}
              onFind={() => {}}
              onOpenFolder={onOpenFolder}
              hasSummary={!!aiSummary}
            />
          </div>
        </div>
      )}

      {isSummaryLoading ? (
        <div className="flex flex-col h-full">
          {/* Show button group during generation */}
          <div className="flex items-center justify-center pt-8 pb-4">
            <SummaryGeneratorButtonGroup
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
              onSaveModelConfig={onSaveModelConfig}
              onGenerateSummary={onGenerateSummary}
              onStopGeneration={onStopGeneration}
              customPrompt={customPrompt}
              summaryStatus={summaryStatus}
              availableTemplates={availableTemplates}
              selectedTemplate={selectedTemplate}
              onTemplateSelect={onTemplateSelect}
              hasTranscripts={transcripts.length > 0}
              isModelConfigLoading={isModelConfigLoading}
              onOpenModelSettings={onOpenModelSettings}
            />
          </div>
          {/* Loading spinner */}
          <div className="flex items-center justify-center flex-1">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mb-4"></div>
              <p style={{ color: 'var(--text-secondary)' }}>Generating AI Summary...</p>
            </div>
          </div>
        </div>
      ) : !aiSummary ? (
        <div className="flex flex-col h-full">
          {/* Centered Summary Generator Button Group when no summary */}
          <div className="flex items-center justify-center pt-8 pb-4">
            <SummaryGeneratorButtonGroup
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
              onSaveModelConfig={onSaveModelConfig}
              onGenerateSummary={onGenerateSummary}
              onStopGeneration={onStopGeneration}
              customPrompt={customPrompt}
              summaryStatus={summaryStatus}
              availableTemplates={availableTemplates}
              selectedTemplate={selectedTemplate}
              onTemplateSelect={onTemplateSelect}
              hasTranscripts={transcripts.length > 0}
              isModelConfigLoading={isModelConfigLoading}
              onOpenModelSettings={onOpenModelSettings}
            />
          </div>
          {/* Empty state message */}
          <EmptyStateSummary
            onGenerate={() => onGenerateSummary(customPrompt)}
            hasModel={modelConfig.provider !== null && modelConfig.model !== null}
            isGenerating={isSummaryLoading}
          />
        </div>
      ) : transcripts?.length > 0 && (
        <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ minHeight: 0 }}>
          {summaryResponse && (
            <div className="fixed bottom-0 left-0 right-0 shadow-lg p-4 max-h-1/3 overflow-y-auto bg-[var(--panel-bg)]">
              <h3 className="text-lg font-semibold mb-2">Meeting Summary</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-[var(--panel-elevated)]">
                  <h4 className="font-medium mb-1">Key Points</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.key_points.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-4 rounded-lg bg-[var(--panel-elevated)] mt-4">
                  <h4 className="font-medium mb-1">Action Items</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.action_items.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-4 rounded-lg bg-[var(--panel-elevated)] mt-4">
                  <h4 className="font-medium mb-1">Decisions</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.decisions.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-4 rounded-lg bg-[var(--panel-elevated)] mt-4">
                  <h4 className="font-medium mb-1">Main Topics</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.main_topics.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
              </div>
              {summaryResponse.raw_summary ? (
                <div className="mt-4">
                  <h4 className="font-medium mb-1">Full Summary</h4>
                  <p className="text-sm whitespace-pre-wrap">{summaryResponse.raw_summary}</p>
                </div>
              ) : null}
            </div>
          )}
          <div className="p-6 w-full">
            <BlockNoteSummaryView
              ref={summaryRef}
              summaryData={aiSummary}
              onSave={onSaveSummary}
              onSummaryChange={onSummaryChange}
              onDirtyChange={onDirtyChange}
              status={summaryStatus}
              error={summaryError}
              onRegenerateSummary={() => {
                Analytics.trackButtonClick('regenerate_summary', 'meeting_details');
                onRegenerateSummary();
              }}
              meeting={{
                id: meeting.id,
                title: meetingTitle,
                created_at: meeting.created_at
              }}
            />
          </div>
          {summaryStatus !== 'idle' && (
            <div className={`mt-4 p-4 rounded-lg ${summaryStatus === 'error' ? 'bg-red-100 text-red-700' :
              summaryStatus === 'completed' ? 'bg-green-100 text-green-700' :
                'bg-blue-100 text-blue-700'
              }`}>
              <p className="text-sm font-medium">{getSummaryStatusMessage(summaryStatus)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Databricks auth / config banner ──────────────────────────────────────────

function DatabricksAuthBanner({
  noWorkspace,
  noEndpoint,
  authFailed,
  authCommand,
  cliProfile,
  onOpenSettings,
}: {
  noWorkspace: boolean;
  noEndpoint: boolean;
  authFailed: boolean;
  authCommand: string;
  cliProfile: string | null;
  onOpenSettings?: (fn: () => void) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    navigator.clipboard.writeText(authCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Determine message
  let title = 'Databricks authentication required';
  let body: React.ReactNode;

  if (noWorkspace) {
    title = 'Workspace URL not configured';
    body = (
      <span>
        Open <strong>Settings → AI Model</strong>, select the Databricks provider,
        and enter your workspace URL and serving endpoint.
      </span>
    );
  } else if (noEndpoint) {
    title = 'Serving endpoint not configured';
    body = (
      <span>
        Open <strong>Settings → AI Model</strong> and enter the name of your
        Databricks Model Serving chat endpoint.
      </span>
    );
  } else {
    // Auth expired / failed
    body = cliProfile ? (
      <span>
        Your Databricks CLI session for profile <code className="px-1 py-0.5 rounded text-xs font-mono"
          style={{ background: 'rgba(255,149,0,0.15)' }}>{cliProfile}</code> has expired.
        Run the command below in your terminal, then retry.
      </span>
    ) : (
      <span>
        Your Azure CLI session has expired. Run the command below in your
        terminal to sign in again, then retry.
      </span>
    );
  }

  return (
    <div
      className="flex-shrink-0 mx-4 mt-3 mb-1 rounded-xl overflow-hidden"
      style={{ border: '1px solid rgba(255,149,0,0.4)', background: 'rgba(255,149,0,0.08)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,149,0,0.2)' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" style={{ color: '#FF9500', flexShrink: 0 }}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span className="text-xs font-semibold" style={{ color: '#FF9500' }}>{title}</span>
        {onOpenSettings && (
          <button
            onClick={() => onOpenSettings(() => {})}
            className="ml-auto text-xs px-2.5 py-1 rounded-lg font-medium transition-opacity hover:opacity-80"
            style={{ background: 'rgba(255,149,0,0.18)', color: '#FF9500', border: 'none', cursor: 'pointer' }}
          >
            Open Settings
          </button>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--text-primary)' }}>{body}</p>

        {/* CLI command — only shown for auth failures, not config issues */}
        {authFailed && (
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)' }}
          >
            <code className="flex-1 text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
              {authCommand}
            </code>
            <button
              onClick={copyCommand}
              className="flex-shrink-0 flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-all"
              style={{
                background: copied ? 'rgba(48,209,88,0.15)' : 'rgba(120,120,128,0.14)',
                color: copied ? 'var(--green)' : 'var(--text-secondary)',
                border: 'none', cursor: 'pointer',
                minWidth: 64,
              }}
            >
              {copied ? (
                <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
