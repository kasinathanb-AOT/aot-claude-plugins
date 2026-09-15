import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TRACKED_FIELDS = [
  ['head', (i) => i.head],
  ['pr.state', (i) => i.pr?.state],
  ['pr.base', (i) => i.pr?.base],
  ['pr.review_decision', (i) => i.pr?.review_decision],
  ['pr.mergeable', (i) => i.pr?.mergeable],
  ['ci.rollup', (i) => i.ci?.rollup],
  ['threads.total', (i) => i.threads?.total],
  ['threads.unresolved_human', (i) => i.threads?.unresolved_human],
  ['threads.unresolved_bot', (i) => i.threads?.unresolved_bot],
  // Counts alone hide churn: one thread resolved plus one new comment leaves every count
  // unchanged, so a PR that just received feedback reports "NO CHANGE". Track identity too.
  ['threads.unresolved_ids', (i) => (i.threads?.unresolved ?? []).map((t) => t.id).sort().join(',')],
  ['git.behind', (i) => i.git?.behind],
  ['flags', (i) => (i.flags ?? []).join(',')],
];

// Identity churn is reported as a readable summary rather than two long id lists.
const FIELD_FORMATTERS = {
  'threads.unresolved_ids': (from, to) => {
    const a = new Set((from ?? '').split(',').filter(Boolean));
    const b = new Set((to ?? '').split(',').filter(Boolean));
    const opened = [...b].filter((x) => !a.has(x)).length;
    const closed = [...a].filter((x) => !b.has(x)).length;
    const parts = [];
    if (opened) parts.push(`${opened} new`);
    if (closed) parts.push(`${closed} resolved`);
    return parts.length ? parts.join(', ') : 'reordered';
  },
};

export function loadSnapshot(path) {
  if (!existsSync(path)) return { state: null, corrupt: false };
  try {
    return { state: JSON.parse(readFileSync(path, 'utf8')), corrupt: false };
  } catch {
    return { state: null, corrupt: true };
  }
}

export function saveSnapshot({ statePath, prevPath, state }) {
  mkdirSync(dirname(statePath), { recursive: true });
  // Unique temp name: two concurrent runs sharing one fixed `.tmp` corrupt each other.
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (existsSync(statePath)) renameSync(statePath, prevPath);
  renameSync(tmp, statePath);
}

export function computeDelta(prev, curr) {
  if (!prev) {
    return { baseline: true, added: curr.items.map((i) => i.branch), removed: [], changed: [] };
  }
  const prevByBranch = new Map(prev.items.map((i) => [i.branch, i]));
  const currByBranch = new Map(curr.items.map((i) => [i.branch, i]));

  const added = curr.items.filter((i) => !prevByBranch.has(i.branch)).map((i) => i.branch);
  const removed = prev.items.filter((i) => !currByBranch.has(i.branch)).map((i) => i.branch);

  const changed = [];
  for (const item of curr.items) {
    const before = prevByBranch.get(item.branch);
    if (!before) continue;
    const changes = [];
    for (const [label, get] of TRACKED_FIELDS) {
      const from = get(before);
      const to = get(item);
      if (from === to) continue;
      const fmt = FIELD_FORMATTERS[label];
      changes.push(fmt ? { field: label, from: '', to: fmt(from, to) } : { field: label, from, to });
    }
    if (changes.length) changed.push({ branch: item.branch, pr: item.pr?.number ?? null, changes });
  }
  return { baseline: false, added, removed, changed };
}

export function carryForwardClassifications(prev, curr) {
  if (!prev) return curr;
  const prior = new Map();
  for (const item of prev.items) {
    for (const t of item.threads?.unresolved ?? []) {
      if (t.classification) prior.set(t.id, { updated_at: t.updated_at, classification: t.classification });
    }
  }
  for (const item of curr.items) {
    for (const t of item.threads?.unresolved ?? []) {
      const hit = prior.get(t.id);
      if (hit && hit.updated_at === t.updated_at) t.classification = hit.classification;
    }
  }
  return curr;
}
