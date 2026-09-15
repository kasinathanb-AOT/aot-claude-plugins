---
name: pr
description: AOT PR work — portfolio queue, per-PR drill, review-thread loop, conflict fix, CI watch, pre-land check and tracker-note sync. Use when the operator invokes /aot:pr.
argument-hint: "[verb] [<pr#>|<branch>] [flags]  ·  verbs: pr review ci fix land notes"
disable-model-invocation: true
allowed-tools: >-
  Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/aot-status.mjs *),
  Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/aot-fix.mjs *),
  Bash(gh:*), Bash(git:*), Bash(dotnet:*),
  Read, Edit, Write, Glob, Grep
---

Arguments: `$ARGUMENTS`

Invoked as `/aot:pr`. All paths below are relative to the repository you are working in — the
scripts auto-detect the repo root, so never hard-code a checkout path. Repo-specific commands,
gates and file locations come from `.aot.json` at the repository root; see **Repo configuration**.

## Routing

Parse `$ARGUMENTS` **yourself, in this skill body**. Never splice an argument into the collector's
command line: the collector accepts only `--json --dry-run --no-fetch --repo= --state=` and now
**rejects anything else with exit 2**, so a spliced PR number aborts the run instead of quietly
collecting the whole portfolio — either way you must do the parsing here.

| First token | Verb |
|---|---|
| empty | `portfolio` |
| all digits | `pr` with that number |
| `pr` `review` `ci` `fix` `land` `notes` | that verb; the next token is the target |
| anything else | stop and print the argument hint |

Unknown flags: stop and say so. Do not guess.

## Write authority — applies to every verb

**Free, no asking:** collect, read threads and comments, classify, poll CI, compute diffs, read files.

**Gated — show the exact command or patch, then wait for an explicit yes:** `git checkout`,
`git commit`, `git push`, resolving a review thread, posting a reply, retargeting a PR base, writing
the tracker note.

**Never, even if asked mid-run:** merge a PR, force-push, delete a branch, `git add -A`, `git commit -a`.

> Generated report files (the paths in `.aot.json` → `reportPaths[]`) are git-tracked and are dirty
> after every local test run. `git add -A` sweeps them into the commit. **Always stage explicit
> pathspecs.**

Commit messages follow the branch's house style: imperative mood, sentence case, no ticket prefix —
e.g. *"Harden settings teardown per review"*.

### Attribution

Default: follow the host's normal attribution guidance for commit messages and PR bodies.

If the config value `keepAttribution` is false (or the environment sets `AOT_KEEP_ATTRIBUTION=0`),
this team/operator prefers commits without assistant attribution — omit `Co-Authored-By` trailers
and generated-with lines. This is a preference toggle, not an override of anything else the host
asks of you.

---

## Repo configuration

Read `.aot.json` from the repository root once per run. Relevant keys:

| Key | Meaning |
|---|---|
| `gates[]` | Ordered verification commands that must all pass before a push |
| `testFilterPrefix` | Namespace root used to qualify test filters |
| `reportPaths[]` | Generated report files that are tracked and must never be reverted or staged |
| `knownFalsePositives[]` | Review findings with a standing rejection and its evidence |
| `matrixPaths[]`, `workflowPath`, `projectPath` | CI matrix registration targets, if the repo uses them |
| `notesPath` | Optional tracker note; overridden by `AOT_NOTES_PATH` |

One concrete example of the shape — your repo's values will differ:

```json
{
  "gates": [
    "dotnet format style --verify-no-changes",
    "dotnet build --configuration Debug --no-restore"
  ],
  "testFilterPrefix": "Tests.WebMigration",
  "reportPaths": ["Reports/index.html", "Reports/dashboard.html"],
  "keepAttribution": true
}
```

If `.aot.json` is missing a key, say so and ask rather than inventing a command.

---

## Step 0 — collect (every verb except `fix`)

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/aot-status.mjs --json
```

Add `--dry-run` for any verb that targets a single PR, so a drill-down does not rotate the portfolio
snapshot.

The snapshot goes stale fast. For any verb targeting one PR, **re-fetch that PR live** rather than
trusting the snapshot — head SHA, threads and CI all move between runs. Report it when the live
numbers disagree with the snapshot; that disagreement is a finding, not noise.

Do not re-derive what the collector already computes with your own `gh`/`git` calls. If a number
looks wrong, say so rather than working around it. Fetching what the collector does **not** cover —
PR body, `issues/{n}/comments`, `pulls/{n}/reviews`, `pulls/{n}/files`, check-run annotations — is
expected and is not re-collection.

---

## `portfolio` — the default

Lead with `delta`: what changed since the last run. If `delta.baseline` is true, say so and skip the
change section. If nothing changed, one line, no padding.

Then a work queue capped at **5 items** — the question is "if I have 30 minutes, what next", not
"list everything".

| Tier | Trigger |
|---|---|
| 🔴 DO NOW | `MERGE_CONFLICT`, `ci.rollup` is `RED`, or an unresolved human thread classified `actionable` |
| 🟠 NEEDS DECISION | `DUPLICATE_HEAD`, `BASE_MISMATCH`, `NO_PR`, `CI_STALE`, `ci.rollup` is `UNKNOWN` |
| 🟡 FOLLOW UP | awaiting review, or `git.true_parent` is a tracked branch that has not merged |
| 🟢 READY | approved + `GREEN` + mergeable + zero unresolved human threads |

Within a tier: **parents before children** — merging a parent unblocks its stack — then oldest
`pr.updated_at` first. Never recommend merging a PR with missing approvals or non-green checks.

---

## `pr <n>` — drill one PR

Re-fetch live. Report:

1. **Identity** — title, base, head SHA, mergeable, review decision, additions/deletions/files.
2. **Flag check** — re-derive each flag against live data. `BASE_MISMATCH` in particular goes stale
   the moment the parent merges; check `true_parent`'s PR state before repeating the flag.
3. **CI** — dedupe by **(check suite, check name)** per head SHA, keeping the newest; two workflows
   can publish the same check name, so name alone collapses distinct legs. Report `raw → deduped`.
   A `cancelled` latest run is `UNKNOWN`, **not** green.
4. **Threads** — every unresolved one, with author, human/bot, path:line, and classification.
5. **Every other comment surface** — `gh api repos/{o}/{r}/issues/{n}/comments` for PR-level
   discussion and `.../pulls/{n}/reviews` for review bodies. Team decisions live there and never
   appear as inline threads. Reading only inline threads will miss the decision that matters.

Flags: `--threads` (full bodies) · `--files` · `--comments`.

---

## `review <n>` — the thread loop

One iteration:

**1. Read every unresolved thread, on every surface.** Inline threads, PR-level issue comments and
review bodies all count. Classify each: `actionable` · `needs-clarification` · `informational` ·
`deferred`. Write the label back so the next run carries it forward. Never read resolved threads —
they are counted, not read.

**2. Verify before fixing.** A review comment is not automatically correct, and automated reviewers
in particular produce findings from local context without the cross-branch view. Read the code the
comment points at and confirm the claim against the tree. Report a rejected comment **with its
evidence** rather than silently complying or silently ignoring it.

Check `.aot.json` → `knownFalsePositives[]` for findings with a standing answer. Two recurring
shapes, stated as rules:

| Shape | Standing answer |
|---|---|
| "Dead code" on a shared page object or helper | Members may be consumed by *sibling* branches not yet merged. Verify with a repo-wide search across branches before deleting; removing them breaks the train. |
| A CI workflow/matrix edit flagged as a forbidden-path violation | The repo's own authoring docs may *require* registering a new category there. Check which document is authoritative and cite it; a boundaries doc can be the stale one. |

**3. Fix only the actionable ones.** Checking the branch out is **gated** — show the command first.
Work in the repository you are in; **do not create worktrees** unless the operator already works in
parallel worktree checkouts and says so. Before starting, compare the local branch to origin: these
branches routinely carry duplicate commits from pull-merges, so a local branch can look "ahead"
while every patch is already on origin. Confirm with `git patch-id` before resetting, and never
discard a genuinely unique local commit.

Authoring rules that apply to any fix come from the repo's own standards file (`CLAUDE.md` and the
skill files it points at). Re-derive rather than assume; where the repo uses a suffix or marker
convention across many files, confirm the current one by counting, e.g. `git grep -c <marker>`, and
never quote a remembered count.

**4. Run every gate in `.aot.json` → `gates[]`, in order.** All must pass. Note that a
0-warning build is not sufficient if the gate list includes an analyser that fails on `info`
severity — run the listed gate, do not substitute the build.

**5. Run the affected fixture. Do not push on a green build alone.** A build proves it compiles;
only a run proves the fix works.

- **Close the browser under test first**, including any instance an MCP server launched. A leftover
  browser holds the profile lock and the run then hangs in `SetUp` for the full timeout, looking
  environmental. Prefer a graceful close; force-kill only when a lock is genuinely held.
- **Never hand-drive an MCP browser to "verify" a locator.** The test launches its own browser, and
  pages opened over CDP are not the app's own tabs — the tab strip renders empty and healthy
  selectors look dead. Run the fixture instead.
- **Namespace-qualify the filter** using `testFilterPrefix`. A bare class name drags in the
  same-named fixture from another platform folder and fakes failures. Set any flow/profile
  environment variable to match the build under test.

```
dotnet test --filter "FullyQualifiedName~<testFilterPrefix>.<Fixture>"
```

- **Read the `Failed! … / Passed! …` summary line, not the exit badge.** A run can report success
  while every test failed. `Passed! - Failed: 0, Passed: 0, Skipped: N` is a **fully skipped**
  fixture, not a pass — assert `passed >= expected && skipped == declared`.
- Open the generated report for per-test detail and failure screenshots. **Never restore, revert or
  delete the files listed in `reportPaths[]`** — they are analysed after the run.
- Launches flake intermittently. A worse result right after an edit is not proof the edit caused it:
  re-run before concluding, and check the code path first.
- Re-run any other fixture sharing a page object you touched.

**6. Push** (gated), then **wait for CI to complete on the new head SHA**. Poll
`gh api repos/{o}/{r}/commits/{sha}/check-runs`, deduped by (check suite, name), until nothing is
`queued` or `in_progress`. Do not read the previous head's result and call it done — `gh pr checks`
can disagree with the runs on the actual head. **A green leg on one OS proves nothing about the other.**

**7. Re-read the threads on every surface.** Pushing wakes the review bots, so new threads normally
appear. If any are actionable, go back to step 2.

**8. Terminate** when a full pass adds no new actionable threads, or when the only thing left needs
a human decision. **Say which of the two ended the loop.**

Report each iteration as: threads read, fixed, rejected (with reason), gate results, **test run
pass/fail/skip counts**, and CI outcome. Never loop silently — a pass that changed nothing still
gets one line.

Flags: `--classify-only` · `--no-push` · `--max-iterations=<n>` (default 3) · `--include-bots`.

---

## `ci <n>` — watch checks

Resolve the **live** head SHA first, then poll
`gh api repos/{o}/{r}/commits/{sha}/check-runs?per_page=100`.

Dedupe by **(check suite, check name)**, keeping the newest by `completed_at ?? started_at`; two
workflows can publish the same check name, and deduping by name alone silently drops a leg. Report
`raw → deduped`.

Rollup: any failure → `RED`; else anything not `completed` → `PENDING`; else any conclusion outside
`success/skipped/neutral` → `UNKNOWN`; else `GREEN`. A `cancelled` latest run is `UNKNOWN`, never
green.

Name the failing checks. For a failure, fetch its annotations rather than guessing from the name.

Flags: `--watch` (poll until settled) · `--timeout=<min>` (default 30).

---

## `fix [branch]` — merge conflicts

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/aot-fix.mjs [--branch=<name>] [--apply]
```

Dry run by default — nothing staged, committed or pushed. It works in a throwaway worktree under the
system temp dir and never touches your checkout or `origin`.

Report per branch: auto-resolved files with the rule applied, and files needing a human. **Always
read the CI workflow resolution** (`.aot.json` → `workflowPath`) — it is flagged `REVIEW THIS ONE`
because it takes the base branch's version and re-appends the branch's category options, which is
the one rule that can silently drop a registration.

`--apply` is **gated**. It lands a merge commit at `refs/aot-fix/<branch>` — not on any branch, not
pushed. Inspect before using.

Never auto-resolve page-object conflicts. That is deliberate.

---

## `land <n>` — pre-merge check

Read-only. Report pass/fail per line, and state plainly whether it is safe to merge:

- [ ] `reviewDecision` is `APPROVED`
- [ ] CI `GREEN` on the **live** head SHA, deduped by (check suite, name)
- [ ] `mergeable` is `MERGEABLE`
- [ ] zero unresolved **human** threads, across inline threads *and* PR-level comments
- [ ] `pr.base` equals `git.true_parent`, or the true parent has merged
- [ ] no `DUPLICATE_HEAD`
- [ ] every OS leg is green, not just the first one to report

Never recommend merging with missing approvals or non-green checks. **Never merge it yourself.**

---

## `notes` — sync the tracker note

**Optional step.** The target is the note configured as `AOT_NOTES_PATH` (falling back to
`.aot.json` → `notesPath`). **If neither is set, skip this verb entirely and say you skipped it
because no tracker note is configured.** Never guess a path.

When it is configured:

**Re-read from disk now** — never from cache or memory. Note editors re-pad markdown tables on open,
so only the on-disk bytes are authoritative. Preserve the file's existing encoding and line endings.

Write only into the sections the operator's own note uses for generated state. Prefer
marker-delimited blocks (`<!-- aot:open-prs:start -->` … `<!-- aot:open-prs:end -->`) and, when a
note has none, ask which headings are yours to write before touching anything. Typical generated
content:

- **Open PRs** — a row per open PR: number and link, branch, base, head, CI glyph, resolved/open
  thread counts, review state. Use a bare glyph or an em dash for not-run, and mark a non-default
  base visibly.
- **Merged** — move a row when a PR is newly `MERGED`. Leave any prose column blank; prose is the
  operator's to write.
- **No PR — needs a decision** — propose branch and ahead-count, with a "needs a verdict" marker.
  **Never invent a verdict.**

**Never touch** hand-written analysis sections — watch-outs, in-progress notes, teammate branches,
or anything outside your markers. If in doubt, leave it.

Show the diff and **stop**. On approval, copy to `<name>.bak` first, then apply, preserving the
original encoding and line endings.

---

## Constraints

- Report the numbers the collector produced. If something looks implausible, flag it as a possible
  collector bug rather than silently substituting your own figure.
- Never write tracking artifacts — specs, collector output, notes — into the repository. Resolving
  conflicts and fixing review findings on your own branches **is** the work and is exempt.
- A test run dirties the generated reports and creates a results directory. **Leave both.**
- A PR reply draft carries **no "not pushed yet" line** — replies are posted only after pushing.
