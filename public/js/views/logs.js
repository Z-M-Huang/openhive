/** Log Viewer — fetches /api/v1/logs with pagination and level/search filters. */

import { createTable } from '../components/table.js';
import { createFilters } from '../components/filters.js';

const PAGE_SIZE = 50;

function levelBadgeClass(level) {
  switch (level) {
    case 'error': return 'badge badge-error';
    case 'warn':  return 'badge badge-warn';
    case 'info':  return 'badge badge-active';
    case 'audit': return 'badge badge-type';
    case 'debug': return 'badge badge-inactive';
    case 'trace': return 'badge badge-inactive';
    default:      return 'badge';
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
  { key: 'level', label: 'Level', sortable: true, render: (v) => makeBadge(v, levelBadgeClass(v)) },
  { key: 'message', label: 'Message', sortable: false, render: (v) => v && v.length > 120 ? v.slice(0, 120) + '...' : v },
  { key: 'durationMs', label: 'Duration', sortable: true, render: (v) => v != null ? `${v}ms` : '' },
  { key: 'createdAt', label: 'Time', sortable: true, render: (v) => formatTime(v) },
];

const filterDefs = [
  { key: 'level', label: 'Level', type: 'select', options: [
    { value: 'error', label: 'Error' },
    { value: 'warn', label: 'Warn' },
    { value: 'info', label: 'Info' },
    { value: 'audit', label: 'Audit' },
    { value: 'debug', label: 'Debug' },
    { value: 'trace', label: 'Trace' },
  ]},
  { key: 'search', label: 'Search', type: 'text', placeholder: 'Search messages...' },
];

async function fetchLogs(params) {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  if (params.level) qs.set('level', params.level);
  if (params.search) qs.set('search', params.search);
  if (params.since) qs.set('since', params.since);
  const res = await fetch(`/api/v1/logs?${qs}`);
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

export async function render(container) {
  container.textContent = '';
  let currentOffset = 0;
  let currentFilters = {};
  let tableRef = null;

  const heading = document.createElement('h2');
  heading.textContent = 'Log Viewer';
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

  async function loadLogs() {
    try {
      const { data, total } = await fetchLogs({ limit: PAGE_SIZE, offset: currentOffset, ...currentFilters });
      if (tableRef) {
        tableRef.update(data);
      } else {
        tableRef = createTable(tableContainer, { columns, data, sortable: true });
      }
      renderPagination(paginationContainer, {
        offset: currentOffset,
        total,
        onPage(page) { currentOffset = page * PAGE_SIZE; loadLogs(); },
      });
    } catch (err) {
      tableContainer.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.textContent = `Failed to load logs: ${err.message ?? err}`;
      tableContainer.append(msg);
    }
  }

  createFilters(filterContainer, {
    filters: filterDefs,
    onChange(values) {
      currentFilters = values;
      currentOffset = 0;
      loadLogs();
    },
  });

  await loadLogs();
}
