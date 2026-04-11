/** Plugin Tools view — fetches /api/v1/tools with team filter. */

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

function renderActions(_v, row) {
  const wrapper = document.createElement('span');

  if (row.status === 'active') {
    const btn = document.createElement('button');
    btn.textContent = 'Deprecate';
    btn.className = 'btn btn-danger';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/v1/tools/${encodeURIComponent(row.teamName)}/${encodeURIComponent(row.toolName)}/deprecate`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        showToast(`Tool "${row.toolName}" deprecated`, 'success');
        if (reloadFn) reloadFn();
      } catch (err) {
        showToast(`Failed to deprecate tool: ${err.message ?? err}`, 'error');
        btn.disabled = false;
      }
    });
    wrapper.append(btn);
  }

  if (row.status !== 'removed') {
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'btn btn-danger';
    btn.style.marginLeft = '4px';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/v1/tools/${encodeURIComponent(row.teamName)}/${encodeURIComponent(row.toolName)}/remove`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        showToast(`Tool "${row.toolName}" removed`, 'success');
        if (reloadFn) reloadFn();
      } catch (err) {
        showToast(`Failed to remove tool: ${err.message ?? err}`, 'error');
        btn.disabled = false;
      }
    });
    wrapper.append(btn);
  }

  return wrapper;
}

const columns = [
  { key: 'teamName', label: 'Team', sortable: true },
  { key: 'toolName', label: 'Tool', sortable: true, render: (v) => { const s = document.createElement('span'); s.className = 'text-mono'; s.textContent = v; return s; } },
  { key: 'status', label: 'Status', sortable: true, render: (v) => makeBadge(v, statusBadgeClass(v)) },
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
