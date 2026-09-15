# AOT Claude Code plugins

A private Claude Code plugin marketplace for AOT engineering.

| Plugin | What it does |
|---|---|
| [`aot`](plugins/aot) | PR portfolio queue, review loop, CI watch, merge-conflict resolution, and migration-ticket intake |

## Install

```bash
claude plugin marketplace add AOT-Technologies/aot-claude-plugins
claude plugin install aot@aot-tools --scope user
```

Then see [`plugins/aot/README.md`](plugins/aot/README.md) for configuration and the command list.

> **SSH is the reliable transport.** Claude Code disables git credential helpers during background
> auto-update, so HTTPS pulls of a private marketplace can fail without a visible error. Check
> `ssh -T git@github.com` succeeds before installing. If you must use HTTPS, run `gh auth setup-git`
> and update manually with `claude plugin update` rather than relying on auto-update.

## Adding a plugin to this marketplace

1. Create `plugins/<name>/` with a `.claude-plugin/plugin.json` (only `name` is required).
2. Add an entry to `.claude-plugin/marketplace.json` pointing at `./plugins/<name>`.
3. Validate both before pushing:

   ```bash
   claude plugin validate ./plugins/<name>
   claude plugin validate .
   ```

4. Bump the plugin's `version`. Engineers receive an update only when the version changes, so
   pushing without a bump ships nothing.

## Private by design

This marketplace is private and should stay that way. The plugins encode client repository
structure, product internals discovered during testing, and review conventions. None of that is
appropriate for a public repository.
