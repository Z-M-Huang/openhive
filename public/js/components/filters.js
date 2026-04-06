/**
 * Filter bar component — renders inputs/selects and calls onChange when values change.
 *
 * @param {HTMLElement} container — parent element to render into
 * @param {object} opts
 * @param {Array<{ key: string, label: string, type: 'text'|'select', options?: Array<{ value: string, label: string }>, placeholder?: string }>} opts.filters
 * @param {(values: Record<string, string>) => void} opts.onChange
 * @returns {{ getValues(): Record<string, string>, reset(): void }}
 */
export function createFilters(container, { filters = [], onChange }) {
  const values = {};
  const elements = {};

  const bar = document.createElement('div');
  bar.className = 'filter-bar';

  for (const filter of filters) {
    values[filter.key] = '';

    if (filter.type === 'select') {
      const select = document.createElement('select');
      select.title = filter.label;

      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = filter.label;
      select.append(defaultOpt);

      for (const opt of (filter.options || [])) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        select.append(option);
      }

      select.addEventListener('change', () => {
        values[filter.key] = select.value;
        if (onChange) onChange({ ...values });
      });

      elements[filter.key] = select;
      bar.append(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = filter.placeholder || filter.label;
      input.title = filter.label;

      let debounceTimer = null;
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          values[filter.key] = input.value;
          if (onChange) onChange({ ...values });
        }, 300);
      });

      elements[filter.key] = input;
      bar.append(input);
    }
  }

  container.textContent = '';
  container.append(bar);

  return {
    getValues() {
      return { ...values };
    },
    reset() {
      for (const filter of filters) {
        values[filter.key] = '';
        const el = elements[filter.key];
        if (el) el.value = '';
      }
      if (onChange) onChange({ ...values });
    },
  };
}
