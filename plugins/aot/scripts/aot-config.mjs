// Resolves every machine-specific value the AOT tools need, so nothing is hard-coded to one
// engineer's box. Four layers, highest wins: CLI flag > environment > config file > auto-detection.
//
// The identity split matters. `ghLogin` and `gitAuthorName` are DIFFERENT namespaces:
// `gh pr list --author` wants the GitHub login, `git for-each-ref %(authorname)` wants the commit
// author name. Collapsing them into one field silently yields zero results for anyone whose
// git user.name is not identical to their GitHub login.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const DEFAULT_BOTS = [
  'cursor',
  'coderabbitai',
  'github-actions',
  'copilot-pull-request-reviewer',
  'sonarcloud',
];

export function run(bin, argv, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync(bin, argv, {
      encoding: 'utf8',
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`${bin} ${argv.slice(0, 3).join(' ')} failed: ${detail}`);
  }
}

function parseArgs(argv) {
  const flags = {};
  const unknown = [];
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(a);
    if (!m) { unknown.push(a); continue; }
    flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return { flags, unknown };
}

function pluginDataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, 'aot-tools');
  if (platform() === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'aot-tools');
  }
  return join(homedir(), '.local', 'state', 'aot-tools');
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function nwoFromRemote(repoPath) {
  const url = run('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { allowFail: true });
  if (!url) return null;
  const m = /(?:[:/])([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function detectRepoPath(explicit) {
  const start = explicit || process.cwd();
  const top = run('git', ['-C', start, 'rev-parse', '--show-toplevel'], { allowFail: true });
  return top || explicit || null;
}

function detectMainBranch(repoPath) {
  const sym = run('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (sym) return sym.replace(/^origin\//, '');
  const viaGh = run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: repoPath, allowFail: true });
  return viaGh || 'main';
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns resolved config plus `sources`, recording which layer supplied each value.
 */
export function resolveConfig(argv = []) {
  const { flags, unknown } = parseArgs(argv);
  const env = process.env;
  const sources = {};

  const dataDir = pluginDataDir();
  const personal = readJson(join(dataDir, 'config.json'));

  const pick = (key, flagName, envName, detect) => {
    if (flags[flagName] !== undefined && flags[flagName] !== true) {
      sources[key] = `--${flagName}`;
      return flags[flagName];
    }
    if (env[envName]) { sources[key] = envName; return env[envName]; }
    if (personal[key] !== undefined) { sources[key] = 'config.json'; return personal[key]; }
    const detected = detect ? detect() : undefined;
    if (detected !== undefined && detected !== null) { sources[key] = 'auto-detected'; return detected; }
    sources[key] = 'unset';
    return undefined;
  };

  const repoPath = pick('repoPath', 'repo-path', 'AOT_REPO_PATH', () => detectRepoPath(flags.repo));
  if (!repoPath) {
    throw new Error(
      'Could not find a git repository. Run from inside your clone, or pass --repo-path=<path> / set AOT_REPO_PATH.'
    );
  }

  // Repo-shaped settings travel with the repo so they cannot drift between copies.
  const repoConfig = readJson(join(repoPath, '.aot.json'));
  const fromRepo = (key, fallback) => {
    if (repoConfig[key] !== undefined) { sources[key] = '.aot.json'; return repoConfig[key]; }
    sources[key] = sources[key] ?? 'default';
    return fallback;
  };

  const nwo = pick('nwo', 'nwo', 'AOT_NWO', () =>
    run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: repoPath, allowFail: true })
    || nwoFromRemote(repoPath));
  if (!nwo) {
    throw new Error(
      'Could not determine owner/repo. Check `gh auth status` and that origin is a GitHub remote, or set AOT_NWO=<owner>/<repo>.'
    );
  }

  const ghLogin = pick('ghLogin', 'author', 'AOT_AUTHOR', () =>
    run('gh', ['api', 'user', '--jq', '.login'], { allowFail: true }));
  if (!ghLogin) {
    throw new Error('Could not determine your GitHub login. Run `gh auth login`, or set AOT_AUTHOR=<login>.');
  }

  const gitAuthorName = pick('gitAuthorName', 'git-author', 'AOT_GIT_AUTHOR', () =>
    run('git', ['-C', repoPath, 'config', 'user.name'], { allowFail: true }));
  if (!gitAuthorName) {
    throw new Error('Could not determine your git author name. Run `git config user.name "<name>"`, or set AOT_GIT_AUTHOR.');
  }

  const mainBranch = pick('mainBranch', 'main', 'AOT_MAIN_BRANCH', () => detectMainBranch(repoPath));
  const branchPrefix = pick('branchPrefix', 'branch-prefix', 'AOT_BRANCH_PREFIX', () => repoConfig.branchPrefix ?? '');
  const notesPath = pick('notesPath', 'notes', 'AOT_NOTES_PATH', () => null);
  const prLimit = Number(pick('prLimit', 'pr-limit', 'AOT_PR_LIMIT', () => 60));

  const keepAttributionRaw = pick('keepAttribution', 'keep-attribution', 'AOT_KEEP_ATTRIBUTION', () => true);
  const keepAttribution = !(keepAttributionRaw === false || keepAttributionRaw === 'false' || keepAttributionRaw === '0');

  const stateDir = pick('stateDir', 'state', 'AOT_STATE_DIR', () =>
    join(dataDir, 'state', nwo.replace('/', '-')));
  mkdirSync(stateDir, { recursive: true });

  return {
    repoPath,
    nwo,
    owner: nwo.split('/')[0],
    repo: nwo.split('/')[1],
    ghLogin,
    gitAuthorName,
    mainBranch,
    branchPrefix,
    notesPath,
    prLimit: Number.isFinite(prLimit) && prLimit > 0 ? prLimit : 60,
    keepAttribution,
    stateDir,
    dataDir,
    botAuthors: fromRepo('botAuthors', DEFAULT_BOTS),
    matrixFiles: fromRepo('matrixFiles', []),
    workflowFile: fromRepo('workflowFile', null),
    identicalOk: fromRepo('identicalOk', []),
    projectFile: fromRepo('projectFile', null),
    knownFalsePositives: fromRepo('knownFalsePositives', []),
    isWindows: platform() === 'win32',
    flags,
    unknownArgs: unknown,
    sources,
  };
}

/** Human-readable dump of every resolved key and the layer it came from. */
export function formatConfig(cfg) {
  const rows = [
    ['repo path', cfg.repoPath],
    ['owner/repo', cfg.nwo],
    ['GitHub login', cfg.ghLogin],
    ['git author', cfg.gitAuthorName],
    ['default branch', cfg.mainBranch],
    ['branch prefix', cfg.branchPrefix || '(all branches)'],
    ['notes path', cfg.notesPath || '(unset — notes steps skipped)'],
    ['state dir', cfg.stateDir],
    ['PR limit', cfg.prLimit],
    ['keep Co-Authored-By', cfg.keepAttribution],
  ];
  const keyFor = {
    'repo path': 'repoPath', 'owner/repo': 'nwo', 'GitHub login': 'ghLogin',
    'git author': 'gitAuthorName', 'default branch': 'mainBranch', 'branch prefix': 'branchPrefix',
    'notes path': 'notesPath', 'state dir': 'stateDir', 'PR limit': 'prLimit',
    'keep Co-Authored-By': 'keepAttribution',
  };
  const w = Math.max(...rows.map(([l]) => l.length));
  const lines = rows.map(([l, v]) => `  ${l.padEnd(w)}  ${v}   [${cfg.sources[keyFor[l]] ?? 'default'}]`);
  return ['RESOLVED CONFIGURATION', ...lines].join('\n');
}

/** Preflight: report missing external tools rather than failing deep inside a call. */
export function doctor(cfg) {
  const out = [formatConfig(cfg), '', 'PREREQUISITES'];
  const checks = [
    ['node', ['--version']],
    ['git', ['--version']],
    ['gh', ['--version']],
  ];
  for (const [bin, args] of checks) {
    const v = run(bin, args, { allowFail: true });
    out.push(`  ${bin.padEnd(6)}  ${v ? v.split('\n')[0] : 'NOT FOUND — required'}`);
  }
  const auth = run('gh', ['auth', 'status'], { allowFail: true });
  out.push(`  gh auth  ${auth ? 'authenticated' : 'NOT AUTHENTICATED — run: gh auth login'}`);

  const branches = run('git', ['-C', cfg.repoPath, 'for-each-ref', '--format=%(authorname)', 'refs/remotes/origin'], { allowFail: true });
  const mine = (branches ?? '').split('\n').filter((n) => n === cfg.gitAuthorName).length;
  out.push('', 'SANITY');
  out.push(`  remote branches whose tip author is "${cfg.gitAuthorName}": ${mine}`);
  if (mine === 0) {
    out.push('  ! Zero branches matched. Your git author name probably differs from the commits you push.');
    out.push('    Set AOT_GIT_AUTHOR to the name that appears in `git log --format=%an`.');
  }
  return out.join('\n');
}
