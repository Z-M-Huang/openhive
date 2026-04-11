/** OpenHive Dashboard — hash router with lazy view loading. */

const routes = {
  '/health':        () => loadView('health'),
  '/org-tree':      () => loadView('org-tree'),
  '/tasks':         () => loadView('tasks'),
  '/logs':          () => loadView('logs'),
  '/memories':      () => loadView('memories'),
  '/triggers':      () => loadView('triggers'),
  '/conversations': () => loadView('conversations'),
  '/vault':         () => loadView('vault'),
  '/plugin-tools':  () => loadView('plugin-tools'),
  '/learning':      () => loadView('learning'),
};

const container = document.getElementById('app');

/**
 * Attempt to lazy-load a view module from /js/views/<name>.js.
 * Each view module must export a render(container) function.
 * Falls back to a placeholder if the module does not exist yet.
 */
async function loadView(name, opts) {
  container.textContent = '';
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-view', name);
  container.appendChild(wrapper);
  try {
    const mod = await import(`/js/views/${name}.js`);
    if (typeof mod.render === 'function') {
      mod.render(wrapper, opts);
    } else {
      renderPlaceholder(name, wrapper);
    }
  } catch {
    renderPlaceholder(name, wrapper);
  }
}

function renderPlaceholder(name, target) {
  const el = target || container;
  const heading = document.createElement('h2');
  heading.textContent = name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const msg = document.createElement('p');
  msg.textContent = 'Loading...';
  el.append(heading, msg);
}

function onRouteChange() {
  const hash = location.hash.slice(1) || '/health';
  const loader = routes[hash];
  if (loader) {
    loader();
  } else {
    renderPlaceholder('not-found');
  }
  updateActiveLink(hash);
}

function updateActiveLink(route) {
  document.querySelectorAll('.nav-list a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === route);
  });
}

window.addEventListener('hashchange', onRouteChange);

// Navigate on initial load
if (!location.hash) {
  location.hash = '#/health';
} else {
  onRouteChange();
}
