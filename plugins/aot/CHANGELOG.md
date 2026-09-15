# Changelog

## 1.0.0

First packaged release. Previously a set of personal slash commands copied by hand into
`~/.claude/commands/`.

### Portability

- **Identity is now two values, not one.** The GitHub login (for `gh pr list --author`) and the git
  commit author name (for matching branch tips) are resolved separately. Collapsing them returned
  zero results with no error for anyone whose `git config user.name` differed from their login.
- **Nothing is hard-coded.** Repository path, owner/repo, both identities, and the default branch
  auto-detect. A new operator configures nothing.
- **Empty results now fail loudly**, naming both resolved identities, instead of reporting
  "NO CHANGE" and exiting 0.
- **Unrecognised arguments are rejected** with exit 2 and a usage message. They were previously
  discarded silently, so a scoped-looking invocation ran a full collect.
- **State moved out of the plugin directory** to the plugin data directory. Writing state next to
  the scripts meant every plugin update silently reset the baseline.
- Repository-shaped settings (conflict-resolution targets, verification gates, generated report
  paths, known false positives) moved to `.aot.json` at the repository root.

### Correctness

- **Check-run dedupe is keyed on (check suite, name).** Keying on name alone collapsed sibling
  platform jobs that publish the same check name, so a failing platform could be hidden behind a
  later-finishing passing one.
- **Change detection tracks thread identity**, not just counts. One thread resolved plus one new
  comment previously left every count unchanged and reported "NO CHANGE".
- Snapshot temp files are process-unique, so concurrent runs cannot corrupt each other.
- Bot classification matches logins exactly instead of by prefix.
- `aot-fix` is scoped to your own branches, consistent with the collector.

### Behaviour

- Commands are namespaced: `/aot:status`, `/aot:pr`, `/aot:issue`.
- The `vault` verb is now `notes`, and the step is skipped entirely when no note path is configured.
- Attribution follows your host's normal behaviour by default; omitting `Co-Authored-By` is opt-in
  via `AOT_KEEP_ATTRIBUTION=0` rather than imposed.
- `--doctor` reports every resolved setting, its source, prerequisites, and a branch-match sanity
  check.
