/** Memories view — fetches /api/v1/memories with pagination and filters. */

import { createTable } from '../components/table.js';
import { createFilters } from '../components/filters.js';

const PAGE_SIZE = 50;

function typeBadgeClass(type) {
  switch (type) {
    case 'identity':   return 'badge badge-active';
    case 'lesson':     return 'badge badge-warn';
    case 'decision':   return 'badge badge-type';
    case 'context':    return 'badge badge-inactive';
    case 'reference':  return 'badge badge-error';
    case 'historical': return 'badge badge-inactive';
    default:           return 'badge';
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

const columns = [
  { key: 'id', label: 'ID', sortable: true, render: (v) => { const s = document.createElement('span'); s.className = 'text-mono'; s.textContent = v; return s; } },
  { key: 'teamName', label: 'Team', sortable: true },
  { key: 'key', label: 'Key', sortable: true },
  { key: 'type', label: 'Type', sortable: true, render: (v) => makeBadge(v, typeBadgeClass(v)) },
  { key: 'supersedesId', label: 'Supersedes', sortable: false, render: (v) => {
    if (v == null) return '';
    const s = document.createElement('span');
    s.className = 'text-mono';
    s.textContent = `#${v}`;
    return s;
  }},
  { key: 'content', label: 'Content', sortable: false, render: (v) => v && v.length > 80 ? v.slice(0, 80) + '...' : v },
  { key: 'updatedAt', label: 'Updated', sortable: true, render: (v) => formatTime(v) },
];

const filterDefs = [
  { key: 'team', label: 'Team', type: 'text', placeholder: 'Filter by team...' },
  { key: 'type', label: 'Type', type: 'select', options: [
    { value: 'identity', label: 'Identity' },
    { value: 'lesson', label: 'Lesson' },
    { value: 'decision', label: 'Decision' },
    { value: 'context', label: 'Context' },
    { value: 'reference', label: 'Reference' },
    { value: 'historical', label: 'Historical' },
  ]},
];

async function fetchMemories(params) {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  if (params.team) qs.set('team', params.team);
  if (params.type) qs.set('type', params.type);
  const res = await fetch(`/api/v1/memories?${qs}`);
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
  heading.textContent = 'Memories';
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

  async function loadMemories() {
    try {
      const { data, total } = await fetchMemories({ limit: PAGE_SIZE, offset: currentOffset, ...currentFilters });
      if (tableRef) {
        tableRef.update(data);
      } else {
        tableRef = createTable(tableContainer, { columns, data, sortable: true });
      }
      renderPagination(paginationContainer, {
        offset: currentOffset,
        total,
        onPage(page) { currentOffset = page * PAGE_SIZE; loadMemories(); },
      });
    } catch (err) {
      tableContainer.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.textContent = `Failed to load memories: ${err.message ?? err}`;
      tableContainer.append(msg);
    }
  }

  createFilters(filterContainer, {
    filters: filterDefs,
    onChange(values) {
      currentFilters = values;
      currentOffset = 0;
      loadMemories();
    },
  });

  await loadMemories();
}
