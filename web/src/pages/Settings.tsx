/**
 * Settings page - system configuration editor with source attribution.
 * Implements AC-G9: read-write config UI, secret redaction, source badges,
 * Save (PUT /api/settings) and Reload Config (POST /api/settings/reload).
 */

import { useState, useEffect } from 'react';
import { useSettings, useUpdateSettings, useReloadConfig } from '@/hooks/useApi';
import { RotateCcw, Save } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A leaf config field as returned by GET /api/settings (getConfigWithSources). */
interface FieldMeta {
  value: unknown;
  source: 'env' | 'yaml' | 'default';
  isSecret?: boolean;
}

/** A settings section — maps field keys to their metadata. */
type Section = Record<string, FieldMeta>;

/** The full settings response: top-level keys are section names, values are sections. */
type SettingsData = Record<string, Section>;

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

const SOURCE_COLORS: Record<string, string> = {
  env: 'bg-purple-700 text-purple-200',
  yaml: 'bg-blue-700 text-blue-200',
  default: 'bg-gray-700 text-gray-400',
};

function SourceBadge({ source }: { source: string }) {
  const cls = SOURCE_COLORS[source] ?? 'bg-gray-700 text-gray-400';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono ${cls}`} title={`Value source: ${source}`}>
      {source}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FieldEditor — renders a single config field
// ---------------------------------------------------------------------------

interface FieldEditorProps {
  sectionKey: string;
  fieldKey: string;
  meta: FieldMeta;
  editValue: string;
  onEdit: (sectionKey: string, fieldKey: string, value: string) => void;
}

function FieldEditor({ sectionKey, fieldKey, meta, editValue, onEdit }: FieldEditorProps) {
  const inputId = `setting-${sectionKey}-${fieldKey}`;
  const labelText = fieldKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  if (meta.isSecret) {
    // Secret fields are always read-only and display '********'
    return (
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">
            {labelText}
          </label>
          <input
            id={inputId}
            type="text"
            value="********"
            readOnly
            aria-label={`${labelText} (secret, read-only)`}
            aria-readonly="true"
            className="w-full bg-gray-900 border border-gray-700 text-gray-500 rounded px-3 py-1.5 text-sm font-mono focus:outline-none cursor-not-allowed"
          />
        </div>
        <div className="pt-5">
          <SourceBadge source={meta.source} />
        </div>
      </div>
    );
  }

  // Boolean toggle
  if (typeof meta.value === 'boolean') {
    const checked = editValue === 'true';
    return (
      <div className="flex items-center gap-3">
        <div className="flex-1 flex items-center gap-3">
          <label htmlFor={inputId} className="text-sm text-gray-300 select-none cursor-pointer">
            {labelText}
          </label>
          <button
            id={inputId}
            role="switch"
            aria-checked={checked}
            aria-label={labelText}
            onClick={() => onEdit(sectionKey, fieldKey, String(!checked))}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              checked ? 'bg-blue-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                checked ? 'translate-x-4' : 'translate-x-1'
              }`}
              aria-hidden="true"
            />
          </button>
        </div>
        <div>
          <SourceBadge source={meta.source} />
        </div>
      </div>
    );
  }

  // Number input
  if (typeof meta.value === 'number') {
    return (
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">
            {labelText}
          </label>
          <input
            id={inputId}
            type="number"
            value={editValue}
            onChange={(e) => onEdit(sectionKey, fieldKey, e.target.value)}
            aria-label={labelText}
            className="w-full bg-gray-900 border border-gray-700 text-white rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="pt-5">
          <SourceBadge source={meta.source} />
        </div>
      </div>
    );
  }

  // Default: text input
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <label htmlFor={inputId} className="block text-xs text-gray-400 mb-1">
          {labelText}
        </label>
        <input
          id={inputId}
          type="text"
          value={editValue}
          onChange={(e) => onEdit(sectionKey, fieldKey, e.target.value)}
          aria-label={labelText}
          className="w-full bg-gray-900 border border-gray-700 text-white rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div className="pt-5">
        <SourceBadge source={meta.source} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section panel
// ---------------------------------------------------------------------------

interface SectionPanelProps {
  title: string;
  sectionKey: string;
  section: Section;
  edits: Record<string, string>;
  onEdit: (sectionKey: string, fieldKey: string, value: string) => void;
}

function SectionPanel({ title, sectionKey, section, edits, onEdit }: SectionPanelProps) {
  const fields = Object.entries(section);

  if (fields.length === 0) return null;

  return (
    <section aria-labelledby={`section-${sectionKey}`} className="bg-gray-800 rounded-lg p-5">
      <h2 id={`section-${sectionKey}`} className="text-base font-semibold text-white mb-4 capitalize">
        {title}
      </h2>
      <div className="space-y-4">
        {fields.map(([fieldKey, meta]) => (
          <FieldEditor
            key={fieldKey}
            sectionKey={sectionKey}
            fieldKey={fieldKey}
            meta={meta}
            editValue={edits[fieldKey] ?? String(meta.value ?? '')}
            onEdit={onEdit}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build initial edit state from the resolved settings data. */
function buildInitialEdits(data: SettingsData): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [section, fields] of Object.entries(data)) {
    result[section] = {};
    for (const [key, meta] of Object.entries(fields)) {
      result[section][key] = String(meta.value ?? '');
    }
  }
  return result;
}

/** Convert edit state back to a flat update payload. */
function buildUpdatePayload(
  data: SettingsData,
  edits: Record<string, Record<string, string>>,
): Record<string, unknown> {
  const payload: Record<string, Record<string, unknown>> = {};
  for (const [section, fields] of Object.entries(edits)) {
    payload[section] = {};
    for (const [key, strVal] of Object.entries(fields)) {
      const originalMeta = data[section]?.[key];
      if (!originalMeta || originalMeta.isSecret) continue;
      const originalType = typeof originalMeta.value;
      if (originalType === 'boolean') {
        payload[section][key] = strVal === 'true';
      } else if (originalType === 'number') {
        const n = Number(strVal);
        payload[section][key] = isNaN(n) ? strVal : n;
      } else {
        payload[section][key] = strVal;
      }
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Section ordering — preferred render order for known sections
// ---------------------------------------------------------------------------

const PREFERRED_SECTION_ORDER = ['server', 'database', 'docker', 'security', 'limits', 'assistant', 'channels'];

function orderedSections(data: SettingsData): [string, Section][] {
  const keys = Object.keys(data);
  const sorted = [
    ...PREFERRED_SECTION_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PREFERRED_SECTION_ORDER.includes(k)),
  ];
  return sorted.map((k) => [k, data[k]]);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Settings() {
  const settingsQuery = useSettings();
  const updateMutation = useUpdateSettings();
  const reloadMutation = useReloadConfig();

  // Track per-section per-field string edit values
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [reloadSuccess, setReloadSuccess] = useState(false);

  // Re-initialise edits whenever the settings data changes (e.g. after reload)
  const rawData = settingsQuery.data as SettingsData | undefined;
  useEffect(() => {
    if (rawData) {
      setEdits(buildInitialEdits(rawData));
    }
  }, [rawData]);

  function handleEdit(sectionKey: string, fieldKey: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [sectionKey]: {
        ...prev[sectionKey],
        [fieldKey]: value,
      },
    }));
    // Clear success banner on any edit
    setSaveSuccess(false);
  }

  function handleSave() {
    if (!rawData) return;
    const payload = buildUpdatePayload(rawData, edits);
    updateMutation.mutate(payload, {
      onSuccess: () => {
        setSaveSuccess(true);
      },
    });
  }

  function handleReload() {
    reloadMutation.mutate(undefined, {
      onSuccess: () => {
        setReloadSuccess(true);
        setSaveSuccess(false);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="flex items-center gap-3">
          {/* Reload Config button */}
          <button
            onClick={handleReload}
            disabled={reloadMutation.isPending || settingsQuery.isLoading}
            aria-label="Reload config from disk"
            aria-busy={reloadMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RotateCcw
              className={`w-4 h-4 ${reloadMutation.isPending ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {reloadMutation.isPending ? 'Reloading...' : 'Reload Config'}
          </button>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={updateMutation.isPending || settingsQuery.isLoading}
            aria-label="Save settings"
            aria-busy={updateMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="w-4 h-4" aria-hidden="true" />
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Success banners */}
      {saveSuccess && !updateMutation.isError && (
        <div role="status" className="bg-green-900/50 text-green-300 px-4 py-3 rounded text-sm">
          Settings saved successfully.
        </div>
      )}
      {reloadSuccess && !reloadMutation.isError && (
        <div role="status" className="bg-green-900/50 text-green-300 px-4 py-3 rounded text-sm">
          Configuration reloaded from disk.
        </div>
      )}

      {/* Error states */}
      {settingsQuery.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Failed to load settings:{' '}
          {settingsQuery.error instanceof Error ? settingsQuery.error.message : 'Unknown error'}
        </div>
      )}
      {updateMutation.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Failed to save settings:{' '}
          {updateMutation.error instanceof Error ? updateMutation.error.message : 'Unknown error'}
        </div>
      )}
      {reloadMutation.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Failed to reload config:{' '}
          {reloadMutation.error instanceof Error ? reloadMutation.error.message : 'Unknown error'}
        </div>
      )}

      {/* Loading state */}
      {settingsQuery.isLoading && (
        <div className="text-gray-500 text-sm">Loading settings...</div>
      )}

      {/* Settings sections */}
      {rawData && (
        <div className="space-y-4">
          {orderedSections(rawData).map(([sectionKey, section]) => (
            <SectionPanel
              key={sectionKey}
              title={sectionKey}
              sectionKey={sectionKey}
              section={section}
              edits={edits[sectionKey] ?? {}}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {/* Source legend */}
      {rawData && !settingsQuery.isLoading && (
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span>Source:</span>
          <span className="flex items-center gap-1.5">
            <SourceBadge source="env" /> environment variable
          </span>
          <span className="flex items-center gap-1.5">
            <SourceBadge source="yaml" /> openhive.yaml
          </span>
          <span className="flex items-center gap-1.5">
            <SourceBadge source="default" /> compiled default
          </span>
        </div>
      )}
    </div>
  );
}
