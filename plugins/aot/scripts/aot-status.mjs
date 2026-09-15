#!/usr/bin/env node
import { join } from 'node:path';
import { loadSnapshot, saveSnapshot, computeDelta, carryForwardClassifications } from './aot-snapshot.mjs';
import { resolveConfig, formatConfig, doctor, run } from './aot-config.mjs';

const KNOWN_FLAGS = new Set([
  'json', 'dry-run', 'no-fetch', 'doctor', 'print-config', 'help',
  'repo-path', 'repo', 'state', 'nwo', 'author', 'git-author', 'main',
  'branch-prefix', 'notes', 'pr-limit', 'keep-attribution',
]);

const USAGE = `aot-status — collect branch/PR state for the current repository

  node aot-status.mjs [--json] [--dry-run] [--no-fetch] [--doctor] [--print-config]

  --json             emit { state, delta } instead of the text report
  --dry-run          do not write the snapshot
  --no-fetch         skip git fetch (ahead/behind goes stale)
  --doctor           print resolved config, prerequisites and a sanity check, then exit
  --print-config     print resolved config and exit

  Overrides (each also settable by environment variable):
  --repo-path=       AOT_REPO_PATH     --nwo=          AOT_NWO
  --author=          AOT_AUTHOR        --git-author=   AOT_GIT_AUTHOR
  --main=            AOT_MAIN_BRANCH   --branch-prefix= AOT_BRANCH_PREFIX
  --notes=           AOT_NOTES_PATH    --state=        AOT_STATE_DIR
  --pr-limit=        AOT_PR_LIMIT`;

const argv = process.argv.slice(2);
const cfg = resolveConfig(argv);

// Strict parsing: an unrecognised argument is an error, never silently discarded. A dropped
// argument previously meant a whole-portfolio collect narrated as if it were scoped.
const bad = [
  ...cfg.unknownArgs,
  ...Object.keys(cfg.flags).filter((f) => !KNOWN_FLAGS.has(f)).map((f) => `--${f}`),
];
if (cfg.flags.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
if (bad.length) {
  process.stderr.write(`aot-status: unrecognised argument(s): ${bad.join(' ')}\n\n${USAGE}\n`);
  process.exit(2);
}

if (cfg.flags.doctor) { process.stdout.write(`${doctor(cfg)}\n`); process.exit(0); }
if (cfg.flags['print-config']) { process.stdout.write(`${formatConfig(cfg)}\n`); process.exit(0); }

const dryRun = Boolean(cfg.flags['dry-run']);
const asJson = Boolean(cfg.flags.json);
const noFetch = Boolean(cfg.flags['no-fetch']);

const statePath = join(cfg.stateDir, 'aot-state.json');
const prevPath = join(cfg.stateDir, 'aot-state.prev.json');
const nwo = cfg.nwo;

const isBot = (login) => !login || cfg.botAuthors.some((b) => login.toLowerCase() === b.toLowerCase());

const git = (argvv, o) => run('git', ['-C', cfg.repoPath, ...argvv], o);
const gh = (argvv, o) => run('gh', argvv, { cwd: cfg.repoPath, ...o });
const ghJson = (argvv) => JSON.parse(gh(argvv));

function preflight() {
  if (gh(['auth', 'status'], { allowFail: true }) === null) {
    throw new Error('gh is not authenticated. Run: gh auth login');
  }
  if (!git(['rev-parse', '--git-dir'], { allowFail: true })) {
    throw new Error(`Not a git repository: ${cfg.repoPath}`);
  }
}

function trackedBranches(prevBranches) {
  const raw = git(['for-each-ref', '--format=%(authorname)\t%(refname:short)', 'refs/remotes/origin']);
  const mine = raw
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([author, ref]) => author === cfg.gitAuthorName && ref && ref !== `origin/${cfg.mainBranch}`)
    .map(([, ref]) => ref.replace(/^origin\//, ''))
    .filter((b) => !cfg.branchPrefix || b.startsWith(cfg.branchPrefix));

  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  if (head && head !== 'HEAD' && head !== cfg.mainBranch && !mine.includes(head)) {
    if (git(['rev-parse', '--verify', `origin/${head}`], { allowFail: true })) mine.push(head);
  }

  return mine.filter((b) => {
    const merged = git(['merge-base', '--is-ancestor', `origin/${b}`, `origin/${cfg.mainBranch}`], { allowFail: true }) !== null;
    return !merged || prevBranches.has(b);
  });
}

function listPullRequests(prevNumbers) {
  const prs = ghJson([
    'pr', 'list', '--repo', nwo, '--state', 'all', '--limit', String(cfg.prLimit),
    '--author', cfg.ghLogin,
    '--json', 'number,state,headRefName,baseRefName,isDraft,title,updatedAt,mergedAt',
  ]);
  return prs.filter((p) => p.state === 'OPEN' || prevNumbers.has(p.number));
}

function fetchThreads(number) {
  const nodes = [];
  let after = null;
  let totalCount = 0;
  let truncated = false;
  let meta = {};

  for (let page = 0; page < 10; page += 1) {
    const query = `query {
      repository(owner: "${cfg.owner}", name: "${cfg.repo}") {
        pullRequest(number: ${number}) {
          headRefOid reviewDecision mergeable
          reviewThreads(first: 100, after: ${after ? JSON.stringify(after) : 'null'}) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved isOutdated path line
              comments(first: 1) { nodes { author { login } body createdAt updatedAt } }
            }
          }
        }
      }
    }`;
    const res = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`]));
    const pr = res?.data?.repository?.pullRequest;
    if (!pr) throw new Error(`GraphQL returned no pullRequest for #${number}`);
    meta = { headRefOid: pr.headRefOid, reviewDecision: pr.reviewDecision, mergeable: pr.mergeable };
    totalCount = pr.reviewThreads.totalCount;
    nodes.push(...pr.reviewThreads.nodes);
    if (!pr.reviewThreads.pageInfo.hasNextPage) break;
    after = pr.reviewThreads.pageInfo.endCursor;
    if (page === 9) truncated = true;
  }

  const unresolved = nodes
    .filter((t) => !t.isResolved)
    .map((t) => {
      const c = t.comments.nodes[0] ?? {};
      const login = c.author?.login ?? null;
      return {
        id: t.id,
        author: login,
        bot: isBot(login),
        path: t.path,
        line: t.line,
        outdated: t.isOutdated,
        updated_at: c.updatedAt ?? c.createdAt ?? null,
        body: (c.body ?? '').slice(0, 4000),
      };
    });

  return {
    meta,
    threads: {
      total: totalCount,
      unresolved_human: unresolved.filter((t) => !t.bot).length,
      unresolved_bot: unresolved.filter((t) => t.bot).length,
      unresolved,
    },
    truncated,
  };
}

function fetchCi(sha) {
  const res = JSON.parse(gh(['api', `repos/${nwo}/commits/${sha}/check-runs?per_page=100`]));
  const runs = res.check_runs ?? [];
  const empty = {
    rollup: 'STALE', checks_failed: [], checks_unknown: [],
    runs_for_head: false, raw_count: 0, deduped_count: 0, truncated: false,
  };
  if (!runs.length) return empty;

  // Dedupe retries, NOT sibling jobs. Two workflows can publish the same check name on one head --
  // Build Validation (Windows) and Build Validation (Mac) both publish `build` -- so keying on the
  // name alone silently discards one platform, and a red Mac build reads as GREEN whenever the
  // Windows run finished later. The check suite is per workflow run, so (suite, name) keeps both
  // platforms while still collapsing genuine re-runs within one suite.
  const latest = new Map();
  for (const r of runs) {
    const stamp = Date.parse(r.completed_at ?? r.started_at ?? 0) || 0;
    const key = `${r.check_suite?.id ?? 'no-suite'}::${r.name}`;
    const prior = latest.get(key);
    if (!prior || stamp >= prior.stamp) latest.set(key, { stamp, run: r });
  }
  const deduped = [...latest.values()].map((v) => v.run);

  const failed = deduped.filter((r) => ['failure', 'timed_out', 'action_required'].includes(r.conclusion));
  const pending = deduped.filter((r) => r.status !== 'completed');
  const unknown = deduped.filter((r) => r.status === 'completed'
    && !['success', 'skipped', 'neutral', 'failure', 'timed_out', 'action_required'].includes(r.conclusion));

  let rollup = 'GREEN';
  if (failed.length) rollup = 'RED';
  else if (pending.length) rollup = 'PENDING';
  else if (unknown.length) rollup = 'UNKNOWN';

  return {
    rollup,
    checks_failed: failed.map((r) => r.name),
    checks_unknown: unknown.map((r) => `${r.name} (${r.conclusion})`),
    runs_for_head: true,
    raw_count: runs.length,
    deduped_count: deduped.length,
    truncated: res.total_count > runs.length,
  };
}

const commitTime = (sha) => {
  const t = git(['show', '-s', '--format=%ct', sha], { allowFail: true });
  return t ? Number(t) : 0;
};

function branchGit(branch, candidates) {
  const counts = git(['rev-list', '--left-right', '--count', `origin/${cfg.mainBranch}...origin/${branch}`], { allowFail: true });
  const [behind, ahead] = (counts ?? '0\t0').split('\t').map(Number);
  const forkPoint = git(['merge-base', `origin/${cfg.mainBranch}`, `origin/${branch}`], { allowFail: true });
  const tip = git(['rev-parse', `origin/${branch}`], { allowFail: true });

  let best = null;
  for (const c of candidates) {
    if (c === branch) continue;
    const mb = git(['merge-base', `origin/${c}`, `origin/${branch}`], { allowFail: true });
    if (!mb || mb === tip) continue;
    // The merge-base must sit on the candidate's own first-parent line. When a CHILD branch merges
    // its parent, merge-base(parent, child) becomes the parent's tip at that moment -- newer than the
    // parent's merge-base with main -- and a plain "newest merge-base wins" rule then names the child
    // as the parent. A commit that arrived by merging is never on the first-parent line, so this
    // rejects the inverted direction while keeping the real one.
    const onFirstParent = git(['merge-base', '--is-ancestor', mb, `origin/${c}`], { allowFail: true }) !== null
      && git(['rev-list', '--first-parent', `origin/${c}`], { allowFail: true })?.split('\n').includes(mb);
    if (!onFirstParent) continue;
    const t = commitTime(mb);
    if (!best || t > best.time) best = { name: c, mb, time: t };
  }

  return {
    ahead,
    behind,
    fork_point: forkPoint ? forkPoint.slice(0, 8) : null,
    true_parent: best?.name ?? cfg.mainBranch,
  };
}

function collect() {
  preflight();
  if (!noFetch) git(['fetch', 'origin', '--prune', '--quiet'], { allowFail: true });

  const { state: prev, corrupt } = loadSnapshot(statePath);
  const prevNumbers = new Set((prev?.items ?? []).map((i) => i.pr?.number).filter(Boolean));
  const prevBranches = new Set((prev?.items ?? []).map((i) => i.branch));

  const branches = trackedBranches(prevBranches);
  const prs = listPullRequests(prevNumbers);

  // A wrong identity produces an empty result that looks exactly like "nothing to do". Fail loudly
  // instead, naming both values so the mismatch is obvious.
  if (!branches.length && !prs.length) {
    throw new Error(
      `No branches authored by "${cfg.gitAuthorName}" and no pull requests by "${cfg.ghLogin}" in ${nwo}.\n`
      + '  These are two different identities: the first is your git commit author name, the second your GitHub login.\n'
      + '  Check them with: node aot-status.mjs --doctor\n'
      + '  Override with AOT_GIT_AUTHOR / AOT_AUTHOR if auto-detection guessed wrong.'
    );
  }

  const prByHead = new Map();
  for (const p of prs) {
    if (!prByHead.has(p.headRefName)) prByHead.set(p.headRefName, []);
    prByHead.get(p.headRefName).push(p);
  }

  const candidates = [cfg.mainBranch, ...branches];
  const allBranches = [...new Set([...branches, ...prs.filter((p) => p.state === 'OPEN').map((p) => p.headRefName)])];

  const items = [];
  for (const branch of allBranches) {
    const prsForBranch = prByHead.get(branch) ?? [];
    const open = prsForBranch.filter((p) => p.state === 'OPEN');
    const primary = open[0] ?? prsForBranch[0] ?? null;
    const flags = [];

    const exists = git(['rev-parse', '--verify', `origin/${branch}`], { allowFail: true });
    if (!exists) {
      items.push({ branch, pr: primary ? { number: primary.number, state: primary.state } : null, flags: ['GONE'] });
      continue;
    }

    const g = branchGit(branch, candidates);
    let pr = null;
    let threads = { total: 0, unresolved_human: 0, unresolved_bot: 0, unresolved: [] };
    let ci = { rollup: 'STALE', checks_failed: [], checks_unknown: [], runs_for_head: false, raw_count: 0, deduped_count: 0, truncated: false };
    let head = exists.slice(0, 8);

    if (primary) {
      const t = fetchThreads(primary.number);
      threads = t.threads;
      if (t.truncated) flags.push('THREADS_TRUNCATED');
      head = t.meta.headRefOid.slice(0, 8);
      pr = {
        number: primary.number,
        base: primary.baseRefName,
        state: primary.state,
        draft: primary.isDraft,
        title: primary.title,
        review_decision: t.meta.reviewDecision,
        mergeable: t.meta.mergeable,
        updated_at: primary.updatedAt,
        merged_at: primary.mergedAt,
      };
      ci = fetchCi(t.meta.headRefOid);
      if (pr.mergeable === 'CONFLICTING') flags.push('MERGE_CONFLICT');
      if (pr.state === 'OPEN' && pr.base !== g.true_parent) flags.push('BASE_MISMATCH');
      if (open.length > 1) flags.push('DUPLICATE_HEAD');
      if (prev && prevNumbers.has(pr.number) && pr.state === 'MERGED') flags.push('NEWLY_MERGED');
    } else {
      flags.push('NO_PR');
    }

    if (ci.rollup === 'STALE' && primary) flags.push('CI_STALE');

    items.push({
      branch,
      pr,
      head,
      git: g,
      ci,
      threads,
      duplicate_prs: open.length > 1 ? open.map((p) => p.number) : undefined,
      flags,
    });
  }

  const state = {
    version: 2,
    generated_at: new Date().toISOString(),
    repo: nwo,
    gh_login: cfg.ghLogin,
    git_author: cfg.gitAuthorName,
    items,
  };
  carryForwardClassifications(prev, state);
  const delta = computeDelta(prev, state);
  return { prev, state, delta, corrupt };
}

function report({ state, delta, corrupt }) {
  const L = [];
  L.push(`AOT STATUS  ${state.generated_at.slice(0, 16).replace('T', ' ')}  ${state.repo}`);
  if (corrupt) L.push('! previous snapshot was unreadable — treating this run as a new baseline');
  L.push('');

  const pad = (s, n) => String(s ?? '').padEnd(n);
  L.push(`${pad('PR', 6)}${pad('BRANCH', 52)}${pad('HEAD', 10)}${pad('CI', 9)}${pad('THREADS', 9)}${pad('REVIEW', 18)}FLAGS`);
  for (const i of [...state.items].sort((a, b) => (a.pr?.number ?? 0) - (b.pr?.number ?? 0))) {
    const th = i.threads ? `${i.threads.total}/${i.threads.unresolved_human}h${i.threads.unresolved_bot}b` : '-';
    L.push(
      pad(i.pr?.number ? `#${i.pr.number}` : '—', 6)
      + pad(i.branch.length > 50 ? `${i.branch.slice(0, 49)}…` : i.branch, 52)
      + pad(i.head ?? '—', 10)
      + pad(i.ci?.rollup ?? '—', 9)
      + pad(th, 9)
      + pad((i.pr?.review_decision ?? '—').toLowerCase(), 18)
      + (i.flags ?? []).join(' ')
    );
  }

  L.push('');
  if (delta.baseline) {
    L.push(`BASELINE — first run, ${delta.added.length} items recorded. No delta to report.`);
  } else if (!delta.added.length && !delta.removed.length && !delta.changed.length) {
    L.push('NO CHANGE since last run.');
  } else {
    L.push('CHANGED SINCE LAST RUN');
    for (const b of delta.added) L.push(`  + new: ${b}`);
    for (const b of delta.removed) L.push(`  - gone: ${b}`);
    for (const c of delta.changed) {
      L.push(`  ~ ${c.pr ? `#${c.pr}` : c.branch}`);
      for (const ch of c.changes) L.push(`      ${ch.field}: ${ch.from} → ${ch.to}`);
    }
  }
  return L.join('\n');
}

try {
  const result = collect();
  if (asJson) {
    const warnings = [];
    if (result.corrupt) warnings.push('previous snapshot was unreadable — this run is a new baseline');
    process.stdout.write(`${JSON.stringify({ state: result.state, delta: result.delta, corrupt: result.corrupt, warnings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(result)}\n`);
  }
  if (!dryRun) {
    saveSnapshot({ statePath, prevPath, state: result.state });
  } else {
    process.stderr.write('\n(--dry-run: snapshot not written)\n');
  }
} catch (err) {
  process.stderr.write(`\nAOT STATUS FAILED: ${err.message}\n`);
  process.exit(1);
}
