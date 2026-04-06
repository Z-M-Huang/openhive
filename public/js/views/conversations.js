/** Conversations view — fetches interactions and topics, groups by topic. */

import { createFilters } from '../components/filters.js';

const PAGE_SIZE = 50;

function directionBadge(direction) {
  const span = document.createElement('span');
  span.className = direction === 'inbound' ? 'badge badge-active' : 'badge badge-type';
  span.textContent = direction;
  return span;
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

async function fetchInteractions(params) {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  if (params.channel) qs.set('channel', params.channel);
  if (params.direction) qs.set('direction', params.direction);
  if (params.topic) qs.set('topic', params.topic);
  const res = await fetch(`/api/v1/interactions?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTopics() {
  const res = await fetch('/api/v1/topics?limit=100');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data ?? [];
}

function topicStateBadge(state) {
  const span = document.createElement('span');
  switch (state) {
    case 'active': span.className = 'badge badge-active'; break;
    case 'idle':   span.className = 'badge badge-warn'; break;
    case 'done':   span.className = 'badge badge-inactive'; break;
    default:       span.className = 'badge'; break;
  }
  span.textContent = state;
  return span;
}

function renderInteractionRow(interaction) {
  const row = document.createElement('div');
  row.className = 'interaction-row';
  row.style.cssText = 'display:flex; gap:var(--space-sm); align-items:baseline; padding:var(--space-xs) 0; border-bottom:1px solid var(--border-subtle);';

  const time = document.createElement('span');
  time.className = 'text-mono';
  time.style.cssText = 'min-width:160px; font-size:0.85em; color:var(--text-muted);';
  time.textContent = formatTime(interaction.createdAt);

  const badge = directionBadge(interaction.direction);

  const channel = document.createElement('span');
  channel.style.cssText = 'min-width:80px; font-size:0.85em; color:var(--text-secondary);';
  channel.textContent = interaction.channelType ?? '';

  const snippet = document.createElement('span');
  snippet.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  const text = interaction.contentSnippet ?? '';
  snippet.textContent = text.length > 120 ? text.slice(0, 120) + '...' : text;

  const duration = document.createElement('span');
  duration.className = 'text-mono';
  duration.style.cssText = 'min-width:60px; text-align:right; font-size:0.85em; color:var(--text-muted);';
  duration.textContent = interaction.durationMs != null ? `${interaction.durationMs}ms` : '';

  row.append(time, badge, channel, snippet, duration);
  return row;
}

function renderTopicGroup(topic, interactions) {
  const group = document.createElement('div');
  group.className = 'card';
  group.style.cssText = 'margin-bottom:var(--space-md);';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; gap:var(--space-sm); align-items:center; margin-bottom:var(--space-sm);';

  const name = document.createElement('h3');
  name.textContent = topic.name;
  name.style.margin = '0';

  header.append(name, topicStateBadge(topic.state));

  if (topic.description) {
    const desc = document.createElement('p');
    desc.className = 'text-muted';
    desc.style.cssText = 'font-size:0.85em; margin:var(--space-xs) 0;';
    desc.textContent = topic.description;
    group.append(header, desc);
  } else {
    group.append(header);
  }

  const body = document.createElement('div');
  for (const interaction of interactions) {
    body.append(renderInteractionRow(interaction));
  }
  group.append(body);
  return group;
}

function renderUngroupedInteractions(interactions) {
  const group = document.createElement('div');
  group.className = 'card';
  group.style.cssText = 'margin-bottom:var(--space-md);';

  const header = document.createElement('h3');
  header.textContent = 'Ungrouped';
  header.style.margin = '0 0 var(--space-sm) 0';
  group.append(header);

  const body = document.createElement('div');
  for (const interaction of interactions) {
    body.append(renderInteractionRow(interaction));
  }
  group.append(body);
  return group;
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

const filterDefs = [
  { key: 'channel', label: 'Channel', type: 'text', placeholder: 'Filter by channel ID...' },
  { key: 'direction', label: 'Direction', type: 'select', options: [
    { value: 'inbound', label: 'Inbound' },
    { value: 'outbound', label: 'Outbound' },
  ]},
];

export async function render(container) {
  container.textContent = '';
  let currentOffset = 0;
  let currentFilters = {};
  let topicMap = {};

  const heading = document.createElement('h2');
  heading.textContent = 'Conversations';
  container.append(heading);

  // Filters
  const filterContainer = document.createElement('div');
  container.append(filterContainer);

  // Content area
  const contentArea = document.createElement('div');
  container.append(contentArea);

  // Pagination
  const paginationContainer = document.createElement('div');
  paginationContainer.className = 'pagination';
  container.append(paginationContainer);

  // Load topics once for grouping
  try {
    const topics = await fetchTopics();
    for (const t of topics) { topicMap[t.id] = t; }
  } catch {
    // Topics are non-critical; interactions still render ungrouped
  }

  async function loadInteractions() {
    try {
      const { data, total } = await fetchInteractions({ limit: PAGE_SIZE, offset: currentOffset, ...currentFilters });
      contentArea.textContent = '';

      if (data.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'text-muted';
        empty.textContent = 'No interactions found.';
        contentArea.append(empty);
        paginationContainer.textContent = '';
        return;
      }

      // Group by topicId
      const grouped = {};
      const ungrouped = [];
      for (const item of data) {
        if (item.topicId && topicMap[item.topicId]) {
          if (!grouped[item.topicId]) grouped[item.topicId] = [];
          grouped[item.topicId].push(item);
        } else {
          ungrouped.push(item);
        }
      }

      // Render topic groups (sorted by last interaction time)
      const topicIds = Object.keys(grouped).sort((a, b) => {
        const lastA = grouped[a][0]?.createdAt ?? '';
        const lastB = grouped[b][0]?.createdAt ?? '';
        return lastB.localeCompare(lastA);
      });

      for (const topicId of topicIds) {
        contentArea.append(renderTopicGroup(topicMap[topicId], grouped[topicId]));
      }

      // Render ungrouped interactions
      if (ungrouped.length > 0) {
        contentArea.append(renderUngroupedInteractions(ungrouped));
      }

      renderPagination(paginationContainer, {
        offset: currentOffset,
        total,
        onPage(page) { currentOffset = page * PAGE_SIZE; loadInteractions(); },
      });
    } catch (err) {
      contentArea.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.textContent = `Failed to load interactions: ${err.message ?? err}`;
      contentArea.append(msg);
    }
  }

  createFilters(filterContainer, {
    filters: filterDefs,
    onChange(values) {
      currentFilters = values;
      currentOffset = 0;
      loadInteractions();
    },
  });

  await loadInteractions();
}
