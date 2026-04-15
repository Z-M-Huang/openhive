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

async function fetchLearning(filters) {
  const params = new URLSearchParams();
  if (filters?.team) params.set('team', filters.team);
  if (filters?.subagent) params.set('subagent', filters.subagent);
  const qs = params.toString();
  const res = await fetch('/api/v1/learning' + (qs ? `?${qs}` : ''));
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
  // AC-19: main team is routing-only — never show learning rows for it.
  const visible = teams.filter(t => t.team !== 'main');
  if (visible.length === 0) {
    container.appendChild(el('p', 'No learning or reflection triggers configured for subagent-bearing teams.', 'text-muted'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Team', 'Subagent', 'Trigger', 'Skill', 'State', 'Last Run', 'Status']) {
    headerRow.appendChild(el('th', label));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const team of visible) {
    const triggers = team.triggers.length > 0 ? team.triggers : [{ name: '(none)', skill: null, state: '-', subagent: null }];
    for (const trig of triggers) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', team.team));
      tr.appendChild(el('td', trig.subagent || '—'));
      tr.appendChild(el('td', trig.name));
      tr.appendChild(el('td', trig.skill || '—'));
      tr.appendChild(el('td', trig.state));
      const lastRun = team.lastTriggerRun ? formatTime(team.lastTriggerRun.createdAt) : 'Never';
      const status = team.lastTriggerRun ? team.lastTriggerRun.status : 'n/a';
      tr.appendChild(el('td', lastRun));
      const statusTd = document.createElement('td');
      statusTd.appendChild(makeBadge(status, status === 'done' ? 'badge badge-ok' : status === 'failed' ? 'badge badge-error' : 'badge badge-inactive'));
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    }
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

function buildFilterBar(onChange) {
  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  const teamInput = el('input');
  teamInput.type = 'text';
  teamInput.placeholder = 'Team (optional)';
  teamInput.setAttribute('data-test', 'learning-team-filter');
  const subInput = el('input');
  subInput.type = 'text';
  subInput.placeholder = 'Subagent (optional)';
  subInput.setAttribute('data-test', 'learning-subagent-filter');
  const applyBtn = el('button', 'Apply');
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', () => onChange({ team: teamInput.value.trim(), subagent: subInput.value.trim() }));
  bar.appendChild(el('label', 'Team '));
  bar.appendChild(teamInput);
  bar.appendChild(el('label', ' Subagent '));
  bar.appendChild(subInput);
  bar.appendChild(applyBtn);
  return bar;
}

export async function render(container) {
  container.textContent = '';
  container.appendChild(el('h2', 'Learning Status'));

  const learningSection = createSection('Learning & Reflection Triggers');
  container.appendChild(learningSection);
  const tableHost = document.createElement('div');
  learningSection.appendChild(buildFilterBar(async (filters) => {
    tableHost.textContent = '';
    try {
      const { data } = await fetchLearning(filters);
      renderLearningTable(tableHost, data);
    } catch (err) {
      tableHost.appendChild(el('p', `Failed to load learning status: ${err.message}`, 'text-error'));
    }
  }));
  learningSection.appendChild(tableHost);
  try {
    const { data } = await fetchLearning();
    renderLearningTable(tableHost, data);
  } catch (err) {
    tableHost.appendChild(el('p', `Failed to load learning status: ${err.message}`, 'text-error'));
  }

  const stallSection = createSection('Stall Detection Monitor');
  container.appendChild(stallSection);
  try {
    const stalled = await fetchStalledTasks();
    renderStallTable(stallSection, stalled);
  } catch (err) {
    stallSection.appendChild(el('p', `Failed to load stall data: ${err.message}`, 'text-error'));
  }
}
