/** Tasks view — fetches /api/v1/tasks with pagination and filters. */

import { createTable } from '../components/table.js';
import { createFilters } from '../components/filters.js';

const PAGE_SIZE = 50;

function badgeClass(status) {
  switch (status) {
    case 'pending': return 'badge badge-warn';
    case 'running': return 'badge badge-active';
    case 'done':    return 'badge badge-type';
    case 'failed':  return 'badge badge-error';
    default:        return 'badge badge-inactive';
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
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

const columns = [
  { key: 'id', label: 'ID', sortable: true, render: (v) => { const s = document.createElement('span'); s.className = 'text-mono'; s.textContent = v; return s; } },
  { key: 'teamId', label: 'Team', sortable: true },
  { key: 'task', label: 'Task', sortable: false, render: (v) => v && v.length > 80 ? v.slice(0, 80) + '...' : v },
  { key: 'status', label: 'Status', sortable: true, render: (v) => makeBadge(v, badgeClass(v)) },
  { key: 'priority', label: 'Priority', sortable: true },
  { key: 'type', label: 'Type', sortable: true, render: (v) => makeBadge(v, 'badge badge-type') },
  { key: 'createdAt', label: 'Created', sortable: true, render: (v) => formatTime(v) },
];

const filterDefs = [
  { key: 'status', label: 'Status', type: 'select', options: [
    { value: 'pending', label: 'Pending' },
    { value: 'running', label: 'Running' },
    { value: 'done', label: 'Done' },
    { value: 'failed', label: 'Failed' },
  ]},
  { key: 'type', label: 'Type', type: 'select', options: [
    { value: 'delegate', label: 'Delegate' },
    { value: 'trigger', label: 'Trigger' },
    { value: 'escalation', label: 'Escalation' },
    { value: 'bootstrap', label: 'Bootstrap' },
  ]},
  { key: 'priority', label: 'Priority', type: 'select', options: [
    { value: 'critical', label: 'Critical' },
    { value: 'high', label: 'High' },
    { value: 'normal', label: 'Normal' },
    { value: 'low', label: 'Low' },
  ]},
  { key: 'team', label: 'Team', type: 'text', placeholder: 'Filter by team...' },
];

async function fetchTasks(params) {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  if (params.status) qs.set('status', params.status);
  if (params.team) qs.set('team', params.team);
  if (params.type) qs.set('type', params.type);
  if (params.priority) qs.set('priority', params.priority);
  const res = await fetch(`/api/v1/tasks?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchStats() {
  const res = await fetch('/api/v1/tasks/stats');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return {
    status: body.status ?? body.data ?? {},
    byType: body.byType ?? {},
    byPriority: body.byPriority ?? {},
    byTypeAndPriority: body.byTypeAndPriority ?? [],
  };
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

function renderGroupCards(container, title, entries, testHook) {
  if (entries.length === 0) return;
  const section = document.createElement('section');
  section.setAttribute('data-test', testHook);
  const h = document.createElement('h3');
  h.textContent = title;
  section.append(h);
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  for (const [key, count] of entries) {
    const card = document.createElement('div');
    card.className = 'card';
    const val = document.createElement('div');
    val.className = 'metric-large';
    val.textContent = String(count);
    const label = document.createElement('div');
    label.className = 'metric-label';
    label.textContent = key;
    card.append(val, label);
    grid.append(card);
  }
  section.append(grid);
  container.append(section);
}

function renderTypePriorityMatrix(container, rows) {
  if (rows.length === 0) return;
  const section = document.createElement('section');
  section.setAttribute('data-test', 'stats-type-priority');
  const h = document.createElement('h3');
  h.textContent = 'By Type × Priority';
  section.append(h);
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Type', 'Priority', 'Count']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const { type, priority, count } of rows) {
    const tr = document.createElement('tr');
    const tdT = document.createElement('td'); tdT.textContent = type; tr.append(tdT);
    const tdP = document.createElement('td'); tdP.textContent = priority; tr.append(tdP);
    const tdC = document.createElement('td'); tdC.textContent = String(count); tr.append(tdC);
    tbody.append(tr);
  }
  table.append(tbody);
  section.append(table);
  container.append(section);
}

function renderStatsCards(container, stats) {
  container.textContent = '';
  renderGroupCards(container, 'By Status',   Object.entries(stats.status),     'stats-by-status');
  renderGroupCards(container, 'By Type',     Object.entries(stats.byType),     'stats-by-type');
  renderGroupCards(container, 'By Priority', Object.entries(stats.byPriority), 'stats-by-priority');
  renderTypePriorityMatrix(container, stats.byTypeAndPriority);
}

export async function render(container) {
  container.textContent = '';
  let currentOffset = 0;
  let currentFilters = {};
  let tableRef = null;

  const heading = document.createElement('h2');
  heading.textContent = 'Task Queue';
  container.append(heading);

  // Stats cards
  const statsContainer = document.createElement('div');
  statsContainer.className = 'mb-lg';
  container.append(statsContainer);

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

  async function loadTasks() {
    try {
      const { data, total } = await fetchTasks({ limit: PAGE_SIZE, offset: currentOffset, ...currentFilters });
      if (tableRef) {
        tableRef.update(data);
      } else {
        tableRef = createTable(tableContainer, { columns, data, sortable: true });
      }
      renderPagination(paginationContainer, {
        offset: currentOffset,
        total,
        onPage(page) { currentOffset = page * PAGE_SIZE; loadTasks(); },
      });
    } catch (err) {
      tableContainer.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.textContent = `Failed to load tasks: ${err.message ?? err}`;
      tableContainer.append(msg);
    }
  }

  createFilters(filterContainer, {
    filters: filterDefs,
    onChange(values) {
      currentFilters = values;
      currentOffset = 0;
      loadTasks();
    },
  });

  try {
    const stats = await fetchStats();
    renderStatsCards(statsContainer, stats);
  } catch {
    // Stats are non-critical, table still loads
  }

  await loadTasks();
}
