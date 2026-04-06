/** Org Tree view — fetches /api/v1/teams and renders an interactive tree. */

import { createTree } from '../components/tree.js';

async function fetchTeams() {
  const res = await fetch('/api/v1/teams');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
}

function teamToNode(team) {
  const parts = [];
  if (team.pendingTasks > 0) parts.push(`${team.pendingTasks} pending`);
  if (team.childCount > 0) parts.push(`${team.childCount} children`);
  return {
    id: team.teamId,
    name: team.name,
    parentId: team.parentId,
    status: team.status,
    meta: parts.join(' | '),
  };
}

function renderError(container, err) {
  container.textContent = '';
  const heading = document.createElement('h2');
  heading.textContent = 'Org Tree';
  const msg = document.createElement('p');
  msg.className = 'text-muted mt-md';
  msg.textContent = `Failed to load teams: ${err.message ?? err}`;
  container.append(heading, msg);
}

export async function render(container) {
  container.textContent = '';

  const header = document.createElement('div');
  header.className = 'flex-between mb-lg';
  const heading = document.createElement('h2');
  heading.textContent = 'Org Tree';
  const countLabel = document.createElement('span');
  countLabel.className = 'text-muted';
  header.append(heading, countLabel);
  container.append(header);

  const treeContainer = document.createElement('div');
  treeContainer.className = 'card';
  container.append(treeContainer);

  try {
    const teams = await fetchTeams();
    countLabel.textContent = `${teams.length} team${teams.length !== 1 ? 's' : ''}`;
    const nodes = teams.map(teamToNode);
    createTree(treeContainer, { nodes });
  } catch (err) {
    renderError(container, err);
  }
}
