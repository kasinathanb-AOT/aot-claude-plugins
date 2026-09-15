---
name: status
description: Reports live AOT branch and pull-request state — runs the collector, classifies unresolved review threads, and prints a prioritised work queue. Use when asked what to pick up next, or about the state of a branch, a PR, its CI, or its outstanding review threads.
argument-hint: "[--dry-run] [--no-fetch] [--repo=<path>] [--state=<dir>]"
allowed-tools: >-
  Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/aot-status.mjs *),
  Bash(gh:*), Bash(git:*),
  Read, Glob, Grep
---

Arguments: `$ARGUMENTS`

A **read-only** report on every tracked AOT branch: collect state, classify the unresolved review
threads, print a prioritised work queue, and — only when a tracker note is configured — propose a
diff for it and stop.

This skill does not fix, commit, push, reply, resolve or merge anything. The write half lives in
**`/aot:pr review`**; hand off to it by name rather than starting the work here.

## Write authority

| | |
|---|---|
| **Free** | run the collector, read threads and comments, classify, read files, poll CI, compute a diff |
| **Never** | any `git` write command, any `gh` write command, editing files, applying the tracker diff |

If a finding calls for a change, name the change and the skill that makes it. Do not make it.

## Step 1 — collect

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/aot-status.mjs" --json $ARGUMENTS
```

Run this from the repository you are working in; the collector auto-detects the root, or takes
`--repo=<path>`. It prints `{ state, delta }` and already handles CI dedupe per head SHA,
branch-parent detection and thread resolution state.

Do not re-derive those numbers with your own `gh` or `git` calls. If one looks implausible, say so
and flag it as a possible collector bug rather than quietly substituting your own figure. Fetching
what the collector does **not** cover is expected and is not re-collection: the PR body,
`gh api repos/{o}/{r}/issues/{n}/comments`, `.../pulls/{n}/reviews`, changed files, check-run
annotations. Team decisions frequently live in those surfaces and never appear as inline threads.

Two argument traps:

- The collector **rejects** anything outside its own flags, with exit 2 and a usage message. So a PR
  number spliced into `$ARGUMENTS` fails loudly rather than producing a full-portfolio collect
  narrated as a per-PR answer. Still parse the arguments here and pass through only the flags in the
  argument hint — relying on the collector to catch a mistake wastes a round trip, and a stray flag
  it happens to recognise would change the run.
- Branch tracking keys on the tip-commit author plus the current `HEAD` when it has a remote. If you
  collected from a parallel worktree checkout rather than the main clone, the tracked set differs —
  say which checkout the report came from.

Use `--dry-run` whenever the run is exploratory, so it does not rotate the snapshot that the next
delta is measured against.

## Step 2 — read only what you must

For each item in `state.items`:

- Read the body of every unresolved **human** thread (`threads.unresolved[]` where `bot: false`).
- Read an unresolved **bot** thread only if it carries no `classification` already.
- Never read resolved threads. They are counted, not read.

Classify each thread you read as `actionable`, `needs-clarification`, `informational` or `deferred`,
and report the label in the thread's `classification` field so the next run carries it forward
instead of re-reading.

Classification is a judgement about the comment, not a verdict on the code. Before calling a comment
`actionable`, check it against the known false positives in `.aot.json` → `knownFalsePositives`.
One recurring class: an automated reviewer flags a member of a shared page object as dead code
because nothing in *this* PR's diff calls it, while sibling migration PRs on the same train do —
deleting it breaks them. Cite the consuming file as evidence and classify it `informational`.

## Step 3 — the work queue

**Lead with `delta`** — what changed since the last run. If `delta.baseline` is true, say so plainly
and skip the change section. If nothing changed, say that in one line and do not pad it.

Note the delta's blind spot: it compares thread *counts*, not thread *identities*. One thread
resolved plus one new comment leaves every count unchanged, so a "NO CHANGE" line is not proof that
no feedback arrived.

Then the queue. Apply the tiers in order and cap the whole thing at **5 items** — the question is
"if I have 30 minutes, what next", not "list everything".

| Tier | Trigger |
|---|---|
| 🔴 DO NOW | `MERGE_CONFLICT`, `ci.rollup` is `RED`, or an unresolved human thread classified `actionable` |
| 🟠 NEEDS DECISION | `DUPLICATE_HEAD`, `BASE_MISMATCH`, `NO_PR`, `CI_STALE`, `ci.rollup` is `UNKNOWN` |
| 🟡 FOLLOW UP | awaiting review, or `git.true_parent` is a tracked branch that has not merged |
| 🟢 READY | approved + `GREEN` + mergeable + zero unresolved human threads |

Within a tier, put **parents before children** — merging a parent unblocks its whole stack — then
oldest `pr.updated_at` first. Never recommend merging a PR with missing approvals or non-green
checks, and never merge one yourself.

`BASE_MISMATCH` goes stale the moment the parent merges. Check the true parent's PR state before
repeating the flag.

## Step 4 — the tracker note (optional)

**If `AOT_NOTES_PATH` is unset, skip this step and say you skipped it because no tracker note is
configured.** Do not go looking for one.

When it is set, re-read that file from disk now — never from cache or memory. Editors re-pad
markdown tables on open, so only the on-disk bytes are authoritative; treat the file as UTF-8 with
LF endings.

Write into whatever sections the operator's note uses, and prefer marker-delimited blocks
(`<!-- aot:open-prs -->` … `<!-- /aot:open-prs -->`) over matching on headings, which drift. Anything
outside a marked block is hand-written analysis: leave it alone. Propose only what `state` derives —
PR number, branch, base, head, CI rollup, thread counts, review decision — plus moving a row when a
PR is newly `MERGED`. Columns that are prose, and any verdict on a branch with no PR, are the
operator's to write: propose a placeholder, never invent the judgement.

Show the proposed change **as a diff and stop**. This skill holds no write tools, so it cannot apply
it; hand the diff to the operator, or to `/aot:pr vault`, which applies it under its own gate.

## Reading the numbers

Three things manual inspection reliably gets wrong, which is why the collector's figures win:

- **Dedupe check-runs by `(check suite, name)`, never by name alone.** The endpoint returns every
  attempt, so a name-only rollup collapses genuine retries *and* sibling platform jobs. Two separate
  workflows can publish a check of the same name — the Windows and macOS build validations both
  publish `build` — so keying on the name silently discards one platform, and a red macOS leg reads
  as green whenever Windows finished later. A green Windows leg proves nothing about macOS.
- **A cancelled latest run is `UNKNOWN`, not green.** Rollup order: any failure → `RED`; else
  anything not `completed` → `PENDING`; else any conclusion outside `success` / `skipped` / `neutral`
  → `UNKNOWN`; else `GREEN`. `gh pr checks` can disagree with the runs on the actual head SHA.
- **Thread resolution needs the GraphQL `reviewThreads` field.** REST does not expose `isResolved`.
  Split human from bot before reasoning about the counts.

## Traps carried into the hand-off

State these when they bear on a queue item; they belong to `/aot:pr review`, which does the work.

- **Read the `Failed! … Passed:` summary line, not the exit badge.** A run can report success while
  every test failed — and `Passed! - Failed: 0, Passed: 0, Skipped: N` is a fully skipped fixture,
  not a pass. Assert `passed >= expected && skipped == declared`.
- **Namespace-qualify every test filter.** A bare class name drags in the Desktop fixture of the same
  name and fakes Web failures.
- **Close the browser before a run**, including any launched by an MCP server. A leftover instance
  holds the profile lock and the run then hangs in `SetUp` looking environmental.
- **Never `git add -A` or `git commit -a`.** The generated HTML report files are git-tracked and are
  dirty after every local run; a blanket add sweeps them into the commit. Stage explicit pathspecs.
  Leave those reports dirty — they are the artefact the operator analyses afterwards.
- A launch flakes intermittently. A worse result immediately after an edit is not proof the edit
  caused it: re-run before concluding.

## Configuration

Repository-shaped values come from **`.aot.json` at the repository root**, not from this file:

```json
{
  "repo": "<owner>/<repo>",
  "author": "<github-login>",
  "branchPrefix": "feature/aot-",
  "matrixGroupFile": ".github/actions/matrix/matrix-groups/<group>.json",
  "workflowFile": ".github/workflows/<workflow>.yml",
  "keepAttribution": true,
  "knownFalsePositives": []
}
```

Environment: `AOT_NOTES_PATH` points at the tracker note (unset means step 4 is skipped);
`AOT_KEEP_ATTRIBUTION=0` mirrors `keepAttribution: false`.

**Attribution.** By default, follow the host's normal attribution guidance for commits and PR
bodies. If `keepAttribution` is false (or `AOT_KEEP_ATTRIBUTION=0`), the team's preference is to omit
`Co-Authored-By` trailers — apply that preference where it applies. It does not apply here: this
skill never commits.

Do not hard-code counts or identifiers into a report. Where a convention matters, state the rule and
how to re-derive the evidence — for example, the in-tree category suffix convention, verified with
`git grep -c _Migration`.

## Constraints

- Report the collector's numbers. Flag an implausible one; never replace it.
- Never write tracking artefacts — collector output, specs, notes — into the repository. This skill
  reads that repository and leaves nothing in it.
- Every recommendation names the next action and who performs it. Suggest; do not act.
