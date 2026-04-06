/**
 * Reusable sortable table component.
 *
 * @param {HTMLElement} container — parent element to render into
 * @param {object} opts
 * @param {Array<{ key: string, label: string, sortable?: boolean, render?: (value, row) => string|HTMLElement }>} opts.columns
 * @param {Array<object>} opts.data
 * @param {boolean} [opts.sortable=false] — enable column sorting
 * @param {(key: string, dir: 'asc'|'desc') => void} [opts.onSort] — external sort callback
 * @returns {{ update(data: Array<object>): void }}
 */
export function createTable(container, { columns, data = [], sortable = false, onSort }) {
  let currentSort = { key: null, dir: 'asc' };
  let currentData = data;

  const table = document.createElement('table');
  table.className = 'table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  thead.append(headerRow);

  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  function renderHeaders() {
    headerRow.textContent = '';
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (sortable && col.sortable !== false) {
        th.classList.add('sortable');
        if (currentSort.key === col.key) {
          th.classList.add(currentSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
        th.addEventListener('click', () => {
          if (currentSort.key === col.key) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            currentSort.key = col.key;
            currentSort.dir = 'asc';
          }
          if (onSort) {
            onSort(currentSort.key, currentSort.dir);
          } else {
            sortLocally();
          }
          renderHeaders();
          renderBody();
        });
      }
      headerRow.append(th);
    }
  }

  function sortLocally() {
    const { key, dir } = currentSort;
    if (!key) return;
    currentData = [...currentData].sort((a, b) => {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function renderBody() {
    tbody.textContent = '';
    if (currentData.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length;
      td.className = 'text-muted';
      td.style.textAlign = 'center';
      td.style.padding = 'var(--space-lg)';
      td.textContent = 'No data';
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const row of currentData) {
      const tr = document.createElement('tr');
      for (const col of columns) {
        const td = document.createElement('td');
        const value = row[col.key];
        if (col.render) {
          const rendered = col.render(value, row);
          if (typeof rendered === 'string') {
            td.textContent = rendered;
          } else if (rendered instanceof HTMLElement) {
            td.append(rendered);
          } else {
            td.textContent = String(rendered ?? '');
          }
        } else {
          td.textContent = value != null ? String(value) : '';
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  renderHeaders();
  renderBody();
  container.textContent = '';
  container.append(table);

  return {
    update(newData) {
      currentData = newData;
      if (!onSort && currentSort.key) sortLocally();
      renderBody();
    },
  };
}
