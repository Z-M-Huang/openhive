/** Triggers view — fetches /api/v1/triggers with state toggle. */

import { createTable } from '../components/table.js';
import { createFilters } from '../components/filters.js';
import { showToast } from '../components/toast.js';

const PAGE_SIZE = 50;

function stateBadgeClass(state) {
  switch (state) {
    case 'active':   return 'badge badge-active';
    case 'disabled': return 'badge badge-error';
    case 'pending':  return 'badge badge-warn';
    default:         return 'badge badge-inactive';
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

function renderToggleButton(row) {
  const btn = document.createElement('button');
  if (row.state === 'active') {
    btn.textContent = 'Disable';
    btn.className = 'btn btn-danger';
  } else {
    btn.textContent = 'Enable';
    btn.className = 'btn btn-primary';
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const action = row.state === 'active' ? 'disable' : 'enable';
    try {
      const res = await fetch(`/api/v1/triggers/${row.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      showToast(`Trigger "${row.name}" ${action}d`, 'success');
      if (reloadFn) reloadFn();
    } catch (err) {
      showToast(`Failed to ${action} trigger: ${err.message ?? err}`, 'error');
      btn.disabled = false;
    }
  });

  return btn;
}

const columns = [
  { key: 'id', label: 'ID', sortable: true, render: (v) => { const s = document.createElement('span'); s.className = 'text-mono'; s.textContent = v; return s; } },
  { key: 'team', label: 'Team', sortable: true },
  { key: 'name', label: 'Name', sortable: true },
  { key: 'type', label: 'Type', sortable: true, render: (v) => makeBadge(v, 'badge badge-type') },
  { key: 'state', label: 'State', sortable: true, render: (v) => makeBadge(v, stateBadgeClass(v)) },
  { key: 'consecutiveFailures', label: 'Failures', sortable: true },
  { key: 'updatedAt', label: 'Updated', sortable: true, render: (v) => formatTime(v) },
  { key: '_actions', label: '', sortable: false, render: (_v, row) => renderToggleButton(row) },
];

const filterDefs = [
  { key: 'team', label: 'Team', type: 'text', placeholder: 'Filter by team...' },
  { key: 'name', label: 'Name', type: 'text', placeholder: 'Filter by name...' },
  { key: 'state', label: 'State', type: 'select', options: [
    { value: 'active', label: 'Active' },
    { value: 'disabled', label: 'Disabled' },
    { value: 'pending', label: 'Pending' },
  ]},
];

async function fetchTriggers(params) {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  if (params.team) qs.set('team', params.team);
  if (params.name) qs.set('name', params.name);
  if (params.state) qs.set('state', params.state);
  const res = await fetch(`/api/v1/triggers?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderPagination(container, { offset, total, onPage }) {
  container.textContent = '';
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE);

  if (totalPages <= 1) return;

  const prevBtn = document.createElement('button');
  prevBtn.textContent = 'Prev';
  prevBtn.disabled = currentPage === 0;
  prevBtn.addEventListener('click', () => onPage(currentPage - 1));

  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `Page ${currentPage + 1} of ${totalPages}`;

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next';
  nextBtn.disabled = currentPage >= totalPages - 1;
  nextBtn.addEventListener('click', () => onPage(currentPage + 1));

  container.append(prevBtn, info, nextBtn);
}

export async function render(container, { initialFilters = {} } = {}) {
  container.textContent = '';
  let currentOffset = 0;
  let currentFilters = { ...initialFilters };
  let tableRef = null;

  const heading = document.createElement('h2');
  heading.textContent = 'Triggers';
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

  // Pagination
  const paginationContainer = document.createElement('div');
  paginationContainer.className = 'pagination';
  container.append(paginationContainer);

  async function loadTriggers() {
    try {
      const { data, total } = await fetchTriggers({ limit: PAGE_SIZE, offset: currentOffset, ...currentFilters });
      // Always recreate table to pick up updated toggle buttons
      tableRef = null;
      tableContainer.textContent = '';
      tableRef = createTable(tableContainer, { columns, data, sortable: true });
      renderPagination(paginationContainer, {
        offset: currentOffset,
        total,
        onPage(page) { currentOffset = page * PAGE_SIZE; loadTriggers(); },
      });
    } catch (err) {
      tableContainer.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.textContent = `Failed to load triggers: ${err.message ?? err}`;
      tableContainer.append(msg);
    }
  }

  reloadFn = loadTriggers;

  createFilters(filterContainer, {
    filters: filterDefs,
    onChange(values) {
      currentFilters = values;
      currentOffset = 0;
      loadTriggers();
    },
  });

  await loadTriggers();
}
