#!/usr/bin/env node
// Resolves the merge conflicts that recur when a long-lived branch takes the default branch.
// Works in a throwaway worktree; never touches your checkout or the remote.
//
// Which files are auto-resolvable is REPO-SHAPED, so it comes from `.aot.json` at the git toplevel
// rather than being baked in here. With no `.aot.json`, nothing is auto-resolved and every conflict
// is reported for a human -- safe by default.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, formatConfig, run } from './aot-config.mjs';

const KNOWN_FLAGS = new Set([
  'apply', 'branch', 'help', 'print-config',
  'repo-path', 'repo', 'nwo', 'author', 'git-author', 'main', 'branch-prefix', 'state',
]);

const USAGE = `aot-fix — auto-resolve recurring merge conflicts against the default branch

  node aot-fix.mjs [--branch=NAME] [--apply] [--print-config]

  --branch=NAME   limit to one branch (default: every conflicting branch you authored)
  --apply         commit the merge to refs/aot-fix/<branch> (default: dry run, nothing staged)

  Resolution rules come from .aot.json at the repository root:
    matrixFiles[]  take the default branch's version
    workflowFile   take the default branch's version, re-appending options the branch added
    identicalOk[]  resolve only when both sides are byte-identical`;

const argv = process.argv.slice(2);
const cfg = resolveConfig(argv);

const bad = [
  ...cfg.unknownArgs,
  ...Object.keys(cfg.flags).filter((f) => !KNOWN_FLAGS.has(f)).map((f) => `--${f}`),
];
if (cfg.flags.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
if (bad.length) {
  process.stderr.write(`aot-fix: unrecognised argument(s): ${bad.join(' ')}\n\n${USAGE}\n`);
  process.exit(2);
}
if (cfg.flags['print-config']) { process.stdout.write(`${formatConfig(cfg)}\n`); process.exit(0); }

const apply = Boolean(cfg.flags.apply);
const only = typeof cfg.flags.branch === 'string' ? cfg.flags.branch : null;
const repoPath = cfg.repoPath;

const git = (cwd, argvv, { allowFail = false } = {}) =>
  run('git', ['-c', 'rerere.enabled=false', '-C', cwd, ...argvv], { allowFail });

function conflictedFiles(dir) {
  const out = git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

function stage(dir, file, content) {
  writeFileSync(join(dir, file), content, 'utf8');
  git(dir, ['add', '--', file]);
}

const sideContent = (dir, stageNum, file) =>
  git(dir, ['show', `:${stageNum}:${file}`], { allowFail: true });

const optionLines = (text) =>
  new Set((text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => /^\s*-\s+\S+\s*$/.test(l)));

function resolveWorkflow(dir, file) {
  const ours = sideContent(dir, 2, file);
  const theirs = sideContent(dir, 3, file);
  if (ours === null || theirs === null) return null;
  if (ours === theirs) return { content: theirs, note: 'identical on both sides' };

  const theirLines = optionLines(theirs);
  const missing = [...optionLines(ours)].filter((l) => !theirLines.has(l));
  if (!missing.length) return { content: theirs, note: "took the default branch's version; this branch added no new options" };

  const lines = theirs.split('\n');
  let lastOpt = -1;
  for (let i = 0; i < lines.length; i += 1) if (theirLines.has(lines[i].trimEnd())) lastOpt = i;
  if (lastOpt === -1) return null;
  lines.splice(lastOpt + 1, 0, ...missing);
  return {
    content: lines.join('\n'),
    note: `took the default branch's version, re-appended ${missing.length} option(s): ${missing.map((s) => s.trim()).join(', ')}`,
  };
}

function attempt(branch) {
  const dir = mkdtempSync(join(tmpdir(), 'aot-fix-'));
  const result = { branch, resolved: [], remaining: [], notes: [], committed: false, error: null };
  try {
    git(repoPath, ['worktree', 'add', '--detach', '--quiet', dir, `origin/${branch}`]);
    git(dir, ['merge', '--no-commit', '--no-ff', `origin/${cfg.mainBranch}`], { allowFail: true });

    for (const file of conflictedFiles(dir)) {
      if (cfg.matrixFiles.includes(file)) {
        const theirs = sideContent(dir, 3, file);
        if (theirs === null) { result.remaining.push(file); continue; }
        stage(dir, file, `${theirs}\n`);
        result.resolved.push(file);
        result.notes.push(`${file}: took the default branch's version (matrix file, per .aot.json)`);
        continue;
      }
      if (cfg.workflowFile && file === cfg.workflowFile) {
        const r = resolveWorkflow(dir, file);
        if (!r) { result.remaining.push(file); continue; }
        stage(dir, file, `${r.content}\n`);
        result.resolved.push(file);
        result.notes.push(`${file}: ${r.note} — REVIEW THIS ONE`);
        continue;
      }
      if (cfg.identicalOk.some((s) => file.endsWith(s))) {
        const ours = sideContent(dir, 2, file);
        const theirs = sideContent(dir, 3, file);
        if (ours !== null && ours === theirs) {
          stage(dir, file, `${ours}\n`);
          result.resolved.push(file);
          result.notes.push(`${file}: both sides identical`);
          continue;
        }
      }
      result.remaining.push(file);
    }

    if (!result.remaining.length && apply) {
      git(dir, ['commit', '--no-edit']);
      const sha = git(dir, ['rev-parse', 'HEAD']);
      git(repoPath, ['fetch', dir, 'HEAD', '--quiet'], { allowFail: true });
      git(repoPath, ['update-ref', `refs/aot-fix/${branch}`, sha], { allowFail: true });
      result.committed = true;
      result.sha = sha.slice(0, 8);
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    git(dir, ['merge', '--abort'], { allowFail: true });
    git(repoPath, ['worktree', 'remove', '--force', dir], { allowFail: true });
    rmSync(dir, { recursive: true, force: true });
    git(repoPath, ['worktree', 'prune'], { allowFail: true });
  }
  return result;
}

function conflictingBranches() {
  const raw = git(repoPath, ['for-each-ref', '--format=%(authorname)\t%(refname:short)', 'refs/remotes/origin']);
  const mine = raw
    .split('\n')
    .map((l) => l.split('\t'))
    // Scoped to your own branches, matching aot-status. Without this it reports on teammates'
    // work, which is both noisy and none of its business.
    .filter(([author, ref]) => author === cfg.gitAuthorName && ref)
    .map(([, ref]) => ref.replace(/^origin\//, ''))
    .filter((b) => b !== cfg.mainBranch)
    .filter((b) => !cfg.branchPrefix || b.startsWith(cfg.branchPrefix));

  return mine.filter((b) => {
    const t = git(repoPath, ['merge-tree', '--write-tree', `origin/${cfg.mainBranch}`, `origin/${b}`], { allowFail: true });
    return t === null || /^[0-9]+ [0-9a-f]+ [123]\t/m.test(t);
  });
}

try {
  const branches = only ? [only] : conflictingBranches();
  const out = [];
  out.push(`AOT FIX  ${apply ? '(apply)' : '(dry run — nothing staged or pushed)'}  ${branches.length} branch(es)`);
  if (!only && !branches.length) {
    out.push('');
    out.push(`  No conflicting branches authored by "${cfg.gitAuthorName}".`);
    out.push('  If that looks wrong, check the identity with: node aot-status.mjs --doctor');
  }
  if (!cfg.matrixFiles.length && !cfg.workflowFile) {
    out.push('');
    out.push('  Note: no .aot.json resolution rules found — every conflict will be reported, none resolved.');
  }

  for (const b of branches) {
    const r = attempt(b);
    out.push('');
    out.push(`── ${b}`);
    if (r.error) { out.push(`   ERROR: ${r.error}`); continue; }
    out.push(`   auto-resolved : ${r.resolved.length}`);
    for (const n of r.notes) out.push(`       · ${n}`);
    out.push(`   needs a human : ${r.remaining.length}`);
    for (const f of r.remaining) out.push(`       ✗ ${f}`);
    if (r.committed) out.push(`   merge committed as ${r.sha} → refs/aot-fix/${b}`);
    else if (!r.remaining.length) out.push('   all conflicts resolvable — re-run with --apply to commit');
    else out.push('   STOPPED — resolve the files above by hand, then merge');
  }

  process.stdout.write(`${out.join('\n')}\n`);
} catch (err) {
  process.stderr.write(`\nAOT FIX FAILED: ${err.message}\n`);
  process.exit(1);
}
