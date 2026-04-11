/** Learning Status + Stall Detection view. */

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function makeBadge(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function createSection(title) {
  const section = document.createElement('div');
  section.className = 'card';
  const h = document.createElement('h3');
  h.textContent = title;
  section.appendChild(h);
  return section;
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}

async function fetchLearning() {
  const res = await fetch('/api/v1/learning');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchStalledTasks() {
  const res = await fetch('/api/v1/tasks?status=pending&limit=100');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;
  return (data.data || []).filter(t => {
    const age = now - new Date(t.createdAt).getTime();
    return age > ONE_HOUR;
  }).map(t => {
    const age = now - new Date(t.createdAt).getTime();
    return { ...t, ageHours: Math.floor(age / (60 * 60 * 1000)), isError: age > ONE_DAY };
  });
}

function renderLearningTable(container, teams) {
  if (teams.length === 0) {
    container.appendChild(el('p', 'No learning or reflection triggers configured.', 'text-muted'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Team', 'Triggers', 'Last Run', 'Status']) {
    headerRow.appendChild(el('th', label));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const team of teams) {
    const tr = document.createElement('tr');
    const triggerNames = team.triggers.map(t => `${t.skill || t.name} (${t.state})`).join(', ');
    const lastRun = team.lastTriggerRun ? formatTime(team.lastTriggerRun.createdAt) : 'Never';
    const status = team.lastTriggerRun ? team.lastTriggerRun.status : 'n/a';
    tr.appendChild(el('td', team.team));
    tr.appendChild(el('td', triggerNames));
    tr.appendChild(el('td', lastRun));
    const statusTd = document.createElement('td');
    statusTd.appendChild(makeBadge(status, status === 'done' ? 'badge badge-ok' : status === 'failed' ? 'badge badge-error' : 'badge badge-inactive'));
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderStallTable(container, stalled) {
  if (stalled.length === 0) {
    container.appendChild(el('p', 'No stalled tasks detected.', 'text-muted'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Task ID', 'Team', 'Type', 'Age (hours)', 'Severity']) {
    headerRow.appendChild(el('th', label));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const task of stalled) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', task.id, 'text-mono'));
    tr.appendChild(el('td', task.teamName || task.teamId || ''));
    tr.appendChild(el('td', task.type || ''));
    tr.appendChild(el('td', `${task.ageHours}h`));
    const sevTd = document.createElement('td');
    sevTd.appendChild(makeBadge(task.isError ? 'ERROR (>24h)' : 'WARN (>1h)', task.isError ? 'badge badge-error' : 'badge badge-warn'));
    tr.appendChild(sevTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export async function render(container) {
  container.textContent = '';
  container.appendChild(el('h2', 'Learning Status'));

  // Learning status section
  const learningSection = createSection('Learning & Reflection Triggers');
  container.appendChild(learningSection);
  try {
    const { data } = await fetchLearning();
    renderLearningTable(learningSection, data);
  } catch (err) {
    learningSection.appendChild(el('p', `Failed to load learning status: ${err.message}`, 'text-error'));
  }

  // Stall detection section
  const stallSection = createSection('Stall Detection Monitor');
  container.appendChild(stallSection);
  try {
    const stalled = await fetchStalledTasks();
    renderStallTable(stallSection, stalled);
  } catch (err) {
    stallSection.appendChild(el('p', `Failed to load stall data: ${err.message}`, 'text-error'));
  }
}
