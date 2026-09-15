# `aot` — migration and PR workflow tools

Three skills for working a portfolio of long-lived branches through review to merge, plus turning a
tracker issue into a verified pull request.

| Command | Does | Writes? |
|---|---|---|
| `/aot:status` | Read-only branch/PR state, delta since last run, prioritised work queue | never |
| `/aot:pr` | Portfolio queue, per-PR drill, review loop, CI watch, conflict fix, land check, notes sync | gated |
| `/aot:issue` | Tracker issue → branch → code → verified run → PR, stopping at three gates | gated |

**Write authority is tiered.** Reading, classifying and reporting happen freely. Anything
outward-facing — commit, push, resolving a review thread, posting a reply, retargeting a base,
writing to your notes — shows you the exact command and waits for an explicit yes. Merging,
force-pushing and branch deletion never happen.

## Requirements

| | |
|---|---|
| Claude Code | 2.1.193+ |
| Node | 20.11+ |
| `gh` | authenticated, `repo` scope |
| A git clone | with a GitHub `origin` remote |

Per-repository verification commands (build, format, lint, test) are whatever you configure in
`.aot.json`; the plugin does not assume a language or toolchain.

## Configuration

**Nothing is required.** Everything auto-detects from your clone and `gh` login. Check what it
resolved:

```bash
/aot:status --doctor
```

That prints every setting, the layer it came from, and a sanity check on how many branches matched.

### The one thing that goes wrong

Two identities are involved and they are **not** the same value:

| | Used for | Auto-detected from |
|---|---|---|
| **GitHub login** | `gh pr list --author` | `gh api user` |
| **git author name** | matching branch tip authors | `git config user.name` |

If your `git config user.name` is `Jane Doe` but your GitHub login is `jdoe`, these differ — which
is normal. Auto-detection handles it. Override only if `--doctor` shows something wrong:

```bash
export AOT_AUTHOR=jdoe              # GitHub login
export AOT_GIT_AUTHOR="Jane Doe"    # git commit author name
```

Earlier versions collapsed these into one field, which returned zero results with no error. The
collector now fails loudly and names both values instead.

### All settings

Each is a CLI flag, an environment variable, or a key in `config.json` under your plugin data
directory. Highest wins: flag → environment → config file → auto-detection.

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Repository path | `--repo-path=` | `AOT_REPO_PATH` | git toplevel of cwd |
| Owner/repo | `--nwo=` | `AOT_NWO` | from `gh repo view` |
| GitHub login | `--author=` | `AOT_AUTHOR` | from `gh api user` |
| git author name | `--git-author=` | `AOT_GIT_AUTHOR` | from `git config user.name` |
| Default branch | `--main=` | `AOT_MAIN_BRANCH` | from `origin/HEAD` |
| Branch prefix filter | `--branch-prefix=` | `AOT_BRANCH_PREFIX` | none (all branches) |
| Tracker note path | `--notes=` | `AOT_NOTES_PATH` | unset — notes steps are skipped |
| State directory | `--state=` | `AOT_STATE_DIR` | plugin data directory |
| PR fetch limit | `--pr-limit=` | `AOT_PR_LIMIT` | 60 |
| Keep `Co-Authored-By` | `--keep-attribution=` | `AOT_KEEP_ATTRIBUTION` | `1` (keep) |

**Attribution.** By default the tools follow your host's normal commit-attribution behaviour. If
your team omits `Co-Authored-By` trailers, set `AOT_KEEP_ATTRIBUTION=0`. This is a preference, not
a policy the plugin imposes.

### `.aot.json` — repository shape

Anything that describes *the repository* rather than *you* lives in `.aot.json` at the repo root, so
it travels with the repo instead of drifting between copies. All keys are optional; omitted keys
disable the feature that uses them.

```json
{
  "branchPrefix": "feature/aot-",
  "matrixFiles": [
    ".github/actions/matrix/matrix-groups/full-regression.json",
    ".github/actions/matrix/matrix-groups/full-regression-browser.json"
  ],
  "workflowFile": ".github/workflows/run-automated-tests.yml",
  "identicalOk": ["build/SomeGenerated.targets"],
  "gates": [
    "dotnet format style --verify-no-changes",
    "dotnet format analyzers --verify-no-changes",
    "roslynator analyze <project>.csproj",
    "dotnet build ../ --configuration Debug --no-restore"
  ],
  "reportPaths": ["Reports/index.html", "Reports/dashboard.html"],
  "knownFalsePositives": [
    {
      "matches": "workflow_dispatch options edit flagged as a path violation",
      "answer": "Repository standards require registering new categories there; the generation-boundaries doc is stale."
    }
  ]
}
```

With no `.aot.json`, `/aot:pr fix` reports every conflict for a human and resolves none — safe by
default.

## Why it exists

Three things about GitHub's own status are easy to get wrong by hand:

1. **Check runs must be deduped by (check suite, name), not by name alone.** The API returns every
   attempt, so a stale failed retry can make a healthy PR look broken. But two workflows can also
   publish the *same check name* on one commit — a Windows and a macOS `build`, say — and keying on
   the name alone silently discards one platform. A red build then reads as green because the other
   platform finished later.
2. **A `cancelled` latest run is `UNKNOWN`, not green.** A PR whose CI never completed can otherwise
   report as passing.
3. **Thread resolution state only exists in the GraphQL API.** REST does not expose `isResolved`, so
   an answered review comment is indistinguishable from an open one without it.

The collector handles all three, and stores a snapshot so each run reports what actually changed —
including *which* threads opened and closed, not just how many.

## Scope

`/aot:status` and `/aot:pr` are repository-agnostic. `/aot:issue` encodes a Desktop-to-Web test
migration workflow and is useful mainly in a repository set up for it; its repo-specific rules come
from `.aot.json`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No branches authored by "X" and no pull requests by "Y"` | Identity mismatch — run `--doctor` and compare against `git log --format=%an` |
| `unrecognised argument(s)` | Arguments are validated rather than ignored. Check `--help`. |
| Everything `STALE` | `--no-fetch` against stale refs, or a token without Actions access |
| `gh is not authenticated` | `gh auth login` |
| Baseline reported every run | State directory not persisting — check `--doctor` |
