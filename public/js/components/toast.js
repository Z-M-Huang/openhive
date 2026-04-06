/** Toast notification component. Uses CSS classes from dashboard.css. */

let containerEl = null;

function ensureContainer() {
  if (containerEl) return containerEl;
  containerEl = document.querySelector('.toast-container');
  if (!containerEl) {
    containerEl = document.createElement('div');
    containerEl.className = 'toast-container';
    document.body.append(containerEl);
  }
  return containerEl;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warn'} type
 */
export function showToast(message, type = 'success') {
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.append(toast);

  const timer = setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 3000);

  toast.addEventListener('click', () => {
    clearTimeout(timer);
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  });
}
