/**
 * Tree renderer for org hierarchy.
 *
 * @param {HTMLElement} container — parent element to render into
 * @param {object} opts
 * @param {Array<{ id: string, name: string, parentId: string|null, status?: string, meta?: string, children?: Array }>} opts.nodes — flat list, will be assembled into tree
 * @param {(node: object) => void} [opts.onToggle] — called when a node is expanded/collapsed
 * @returns {{ update(nodes: Array): void }}
 */
export function createTree(container, { nodes = [], onToggle }) {
  const expandedSet = new Set();
  let currentNodes = nodes;

  function buildHierarchy(flat) {
    const map = new Map();
    const roots = [];

    for (const node of flat) {
      map.set(node.id, { ...node, _children: [] });
    }
    for (const node of flat) {
      const entry = map.get(node.id);
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)._children.push(entry);
      } else {
        roots.push(entry);
      }
    }
    return roots;
  }

  function renderNode(node, depth) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'tree-node';

    const hasChildren = node._children && node._children.length > 0;
    const isExpanded = expandedSet.has(node.id);

    // Toggle arrow
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (hasChildren) {
      toggle.textContent = isExpanded ? '\u25BC' : '\u25B6';
      toggle.addEventListener('click', () => {
        if (expandedSet.has(node.id)) {
          expandedSet.delete(node.id);
        } else {
          expandedSet.add(node.id);
        }
        if (onToggle) onToggle(node);
        renderTree();
      });
    }

    // Status indicator
    const indicator = document.createElement('span');
    indicator.className = 'status-indicator';
    if (node.status === 'active') indicator.classList.add('status-active');
    else if (node.status === 'error') indicator.classList.add('status-error');
    else if (node.status === 'shutdown') indicator.classList.add('status-error');
    else indicator.classList.add('status-inactive');

    // Label
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name || node.id;

    // Meta (optional)
    const meta = document.createElement('span');
    meta.className = 'tree-meta';
    meta.textContent = node.meta || '';

    row.append(toggle, indicator, label, meta);
    li.append(row);

    // Render children if expanded
    if (hasChildren && isExpanded) {
      const childUl = document.createElement('ul');
      childUl.className = 'tree';
      for (const child of node._children) {
        childUl.append(renderNode(child, depth + 1));
      }
      li.append(childUl);
    }

    return li;
  }

  function renderTree() {
    container.textContent = '';
    const roots = buildHierarchy(currentNodes);
    const ul = document.createElement('ul');
    ul.className = 'tree';
    for (const root of roots) {
      ul.append(renderNode(root, 0));
    }
    container.append(ul);
  }

  renderTree();

  return {
    update(newNodes) {
      currentNodes = newNodes;
      renderTree();
    },
  };
}
