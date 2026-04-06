/** Health view — fetches /api/v1/overview and renders metric cards with auto-refresh. */

const REFRESH_INTERVAL_MS = 10_000;

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function createMetricCard(label, value) {
  const card = document.createElement('div');
  card.className = 'card';

  const valueEl = document.createElement('div');
  valueEl.className = 'metric-large';
  valueEl.textContent = value;

  const labelEl = document.createElement('div');
  labelEl.className = 'metric-label';
  labelEl.textContent = label;

  card.append(valueEl, labelEl);
  return card;
}

async function fetchOverview() {
  const res = await fetch('/api/v1/overview');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
}

function renderMetrics(container, data) {
  container.textContent = '';

  const header = document.createElement('div');
  header.className = 'flex-between mb-lg';
  const heading = document.createElement('h2');
  heading.textContent = 'System Health';
  const refreshLabel = document.createElement('span');
  refreshLabel.className = 'text-muted';
  refreshLabel.textContent = `Auto-refresh: ${REFRESH_INTERVAL_MS / 1000}s`;
  header.append(heading, refreshLabel);
  container.append(header);

  const grid = document.createElement('div');
  grid.className = 'card-grid';

  grid.append(createMetricCard('Uptime', formatUptime(data.uptime)));
  grid.append(createMetricCard('Teams', String(data.team_count)));
  grid.append(createMetricCard('Queue Depth', String(data.queue_depth)));
  grid.append(createMetricCard('SQLite Size', formatBytes(data.sqlite_size)));
  grid.append(createMetricCard('Triggers (active)', String(data.trigger_stats.active)));
  grid.append(createMetricCard('Triggers (total)', String(data.trigger_stats.total)));

  container.append(grid);
}

function renderError(container, err) {
  container.textContent = '';
  const heading = document.createElement('h2');
  heading.textContent = 'System Health';
  const msg = document.createElement('p');
  msg.className = 'text-muted mt-md';
  msg.textContent = `Failed to load overview: ${err.message ?? err}`;
  container.append(heading, msg);
}

export async function render(container) {
  let intervalId = null;
  let disposed = false;

  async function refresh() {
    if (disposed) return;
    try {
      const data = await fetchOverview();
      if (!disposed) renderMetrics(container, data);
    } catch (err) {
      if (!disposed) renderError(container, err);
    }
  }

  await refresh();
  intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);

  // Cleanup: the app router clears container.textContent before loading a new view,
  // so we use a MutationObserver to detect when our content is removed.
  const observer = new MutationObserver(() => {
    if (!container.firstChild || container.textContent === '') {
      disposed = true;
      if (intervalId) clearInterval(intervalId);
      observer.disconnect();
    }
  });
  observer.observe(container, { childList: true });
}
