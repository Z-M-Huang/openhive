/** Plugin Tools view — fetches /api/v1/tools with team filter.
 *  Lifecycle (AC-29): active → deprecated (with reason) → removed.
 *  Active tools cannot be removed directly; the dashboard enforces deprecate-first.
 */

import { createTable } from '../components/table.js';
import { createFilters } from '../components/filters.js';
import { showToast } from '../components/toast.js';

function statusBadgeClass(status) {
  switch (status) {
    case 'active':              return 'badge badge-active';
    case 'deprecated':          return 'badge badge-warn';
    case 'failed_verification': return 'badge badge-error';
    case 'removed':             return 'badge badge-inactive';
    default:                    return 'badge badge-inactive';
  }
}

function makeBadge(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/** Reference to the reload function, set during render(). */
let reloadFn = null;

async function postLifecycle(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}));
    const msg = parsed.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function renderActions(_v, row) {
  const wrapper = document.createElement('span');
  wrapper.setAttribute('data-test', `actions-${row.teamName}-${row.toolName}`);

  if (row.status === 'active') {
    const btn = document.createElement('button');
    btn.textContent = 'Deprecate';
    btn.className = 'btn btn-warn';
    btn.setAttribute('data-test', 'btn-deprecate');
    btn.addEventListener('click', async () => {
      const reason = window.prompt(`Reason for deprecating "${row.toolName}"? (required)`);
      if (reason === null) return;
      if (reason.trim().length === 0) {
        showToast('Deprecation reason is required', 'error');
        return;
      }
      btn.disabled = true;
      try {
        await postLifecycle(
          `/api/v1/tools/${encodeURIComponent(row.teamName)}/${encodeURIComponent(row.toolName)}/deprecate`,
          { reason: reason.trim(), by: 'dashboard' },
        );
        showToast(`Tool "${row.toolName}" deprecated`, 'success');
        if (reloadFn) reloadFn();
      } catch (err) {
        showToast(`Failed to deprecate tool: ${err.message ?? err}`, 'error');
        btn.disabled = false;
      }
    });
    wrapper.append(btn);
    return wrapper;
  }

  if (row.status === 'deprecated' || row.status === 'failed_verification') {
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'btn btn-danger';
    btn.setAttribute('data-test', 'btn-remove');
    btn.addEventListener('click', async () => {
      if (!window.confirm(`Remove "${row.toolName}"? The source file will be deleted and the audit record retained.`)) return;
      btn.disabled = true;
      try {
        await postLifecycle(
          `/api/v1/tools/${encodeURIComponent(row.teamName)}/${encodeURIComponent(row.toolName)}/remove`,
          { by: 'dashboard' },
        );
        showToast(`Tool "${row.toolName}" removed`, 'success');
        if (reloadFn) reloadFn();
      } catch (err) {
        showToast(`Failed to remove tool: ${err.message ?? err}`, 'error');
        btn.disabled = false;
      }
    });
    wrapper.append(btn);
    return wrapper;
  }

  // removed: no actions, show archived marker
  const note = document.createElement('span');
  note.className = 'text-muted';
  note.textContent = 'archived';
  wrapper.append(note);
  return wrapper;
}

function renderReasonCell(_v, row) {
  const span = document.createElement('span');
  span.className = row.deprecatedReason ? '' : 'text-muted';
  span.textContent = row.deprecatedReason ?? '—';
  return span;
}

function renderLifecycleCell(_v, row) {
  const fragment = document.createDocumentFragment();
  if (row.deprecatedAt) {
    const line = document.createElement('div');
    line.className = 'text-muted';
    line.textContent = `deprecated ${formatTime(row.deprecatedAt)}${row.deprecatedBy ? ` by ${row.deprecatedBy}` : ''}`;
    fragment.append(line);
  }
  if (row.removedAt) {
    const line = document.createElement('div');
    line.className = 'text-muted';
    line.textContent = `removed ${formatTime(row.removedAt)}${row.removedBy ? ` by ${row.removedBy}` : ''}`;
    fragment.append(line);
  }
  if (!row.deprecatedAt && !row.removedAt) {
    const line = document.createElement('span');
    line.className = 'text-muted';
    line.textContent = '—';
    fragment.append(line);
  }
  const wrapper = document.createElement('span');
  wrapper.append(fragment);
  return wrapper;
}

function renderVerificationCell(_v, row) {
  const wrapper = document.createElement('span');
  const v = row.verification ?? {};
  const ts = v.typescript;
  const sec = v.security;
  const parts = [];
  if (ts) parts.push(`ts:${ts.valid ? 'ok' : `err(${ts.errors?.length ?? 0})`}`);
  if (sec) parts.push(`sec:${sec.passed ? 'ok' : 'fail'}`);
  wrapper.className = parts.length > 0 ? 'text-mono' : 'text-muted';
  wrapper.textContent = parts.length > 0 ? parts.join(' · ') : '—';
  return wrapper;
}

const columns = [
  { key: 'teamName', label: 'Team', sortable: true },
  { key: 'toolName', label: 'Tool', sortable: true, render: (v) => { const s = document.createElement('span'); s.className = 'text-mono'; s.textContent = v; return s; } },
  { key: 'status', label: 'Status', sortable: true, render: (v) => makeBadge(v, statusBadgeClass(v)) },
  { key: 'deprecatedReason', label: 'Reason', sortable: false, render: renderReasonCell },
  { key: '_lifecycle', label: 'Lifecycle', sortable: false, render: renderLifecycleCell },
  { key: '_verification', label: 'Verification', sortable: false, render: renderVerificationCell },
  { key: 'updatedAt', label: 'Updated', sortable: true, render: (v) => formatTime(v) },
  { key: '_actions', label: '', sortable: false, render: renderActions },
];

const filterDefs = [
  { key: 'team', label: 'Team', type: 'text', placeholder: 'Filter by team...' },
];

async function fetchTools(params) {
  const qs = new URLSearchParams();
  if (params.team) qs.set('team', params.team);
  const res = await fetch(`/api/v1/tools?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function render(container) {
  container.textContent = '';
  let currentFilters = {};

  const heading = document.createElement('h2');
  heading.textContent = 'Plugin Tools';
  container.append(heading);

  // Filters
  const filterContainer = document.createElement('div');
  container.append(filterContainer);

  // Table
  const tableCard = document.createElement('div');
  tableCard.className = 'card';
  const tableContainer = document.createElement('div');
  tableCard.append(tableContainer);
  container.append(tableCard);

  async function loadTools() {
    try {
      const tools = await fetchTools(currentFilters);
      tableContainer.textContent = '';
      createTable(tableContainer, { columns, data: tools, sortable: true });
    } catch (err) {
      tableContainer.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.textContent = `Failed to load plugin tools: ${err.message ?? err}`;
      tableContainer.append(msg);
    }
  }

  reloadFn = loadTools;

  createFilters(filterContainer, {
    filters: filterDefs,
    onChange(values) {
      currentFilters = values;
      loadTools();
    },
  });

  await loadTools();
}
