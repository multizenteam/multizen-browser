---
name: publish-release
description: Publish a new MultiZen release — bump the version, write the CHANGELOG entry, merge the change to master via a pull request, then tag the merge commit to trigger the GitHub Release build. Use when the user asks to publish, ship, cut, or release a new version.
disable-model-invocation: true
---

# Publish Release

End-to-end release of the MultiZen monorepo. The flow is: **bump → changelog →
PR into `master` → tag → release**. Pushing the `v<version>` tag triggers the
`Release` workflow (`.github/workflows/release.yml`), which builds the 3-OS
binaries and publishes the GitHub Release via electron-builder.

## Repository facts

- Monorepo. The version lives in **two** manifests that must stay in lockstep:
  `package.json` and `apps/desktop/package.json`. electron-builder reads the
  version from the desktop manifest.
- Default branch: `master`. CI (`.github/workflows/ci.yml`) runs a typecheck on
  every PR — the PR must be green before merge.
- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) + SemVer,
  with `[x.y.z]` compare links at the bottom pointing at
  `kiserufetch/multizen-browser-extended`.
- The release itself is created by the workflow, not by hand — your job ends at
  pushing the tag and confirming the workflow published the Release.
- Use the `gh` CLI for all GitHub operations.

## Workflow

Copy this checklist into TodoWrite and track progress:

```
- [ ] 1. Pre-flight: clean master, decide version
- [ ] 2. Create release branch
- [ ] 3. Bump version in both manifests
- [ ] 4. Write the CHANGELOG entry
- [ ] 5. Commit, push, open PR
- [ ] 6. Wait for CI, merge PR into master
- [ ] 7. Tag the merge commit and push the tag
- [ ] 8. Verify the Release workflow published
```

### Step 1 — Pre-flight

```bash
git switch master
git pull --ff-only
git status --porcelain          # must be empty; stop if there are local changes
node .cursor/skills/publish-release/scripts/bump-version.mjs --check   # current version
```

Decide the next version (SemVer):

- **patch** — bug fixes only
- **minor** — new backwards-compatible features
- **major** — breaking changes

If the user did not specify the bump, infer it from the unreleased commits
(`git log v<current>..master --oneline`) and confirm with the user before
proceeding. Set `VERSION` to the resulting `x.y.z` for the rest of the flow.

### Step 2 — Create release branch

```bash
git switch -c release/v<VERSION>
```

### Step 3 — Bump the version

Run the helper — it updates both manifests and fails loudly if they were out of
sync:

```bash
node .cursor/skills/publish-release/scripts/bump-version.mjs <VERSION>
```

`<VERSION>` may be an explicit `x.y.z` or one of `patch|minor|major`. The last
stdout line is the resulting version.

### Step 4 — Write the CHANGELOG entry

Edit `CHANGELOG.md`:

1. Insert a new section directly under the header preamble, above the previous
   release. Use today's date (`YYYY-MM-DD`) and only the categories that apply,
   in this order: **Added, Changed, Deprecated, Removed, Fixed, Security**
   (plus the project's `CI` category when relevant).
2. Add a compare link at the bottom, and keep the list newest-first.

Derive entries from `git log v<previous>..HEAD` — describe user-facing impact,
not raw commit subjects. Template:

```markdown
## [<VERSION>] - <YYYY-MM-DD>

### Added

- <feature, described by its effect on the user>

### Fixed

- <bug fix>
```

Bottom-of-file compare link:

```markdown
[<VERSION>]: https://github.com/kiserufetch/multizen-browser-extended/compare/v<previous>...v<VERSION>
```

### Step 5 — Commit, push, open PR

```bash
git add package.json apps/desktop/package.json CHANGELOG.md
git commit -m "release: v<VERSION>"
git push -u origin release/v<VERSION>
gh pr create --base master --title "release: v<VERSION>" --body "$(cat <<'EOF'
## Summary
- Bump version to v<VERSION>
- Update CHANGELOG

## Notes
Merging this PR does not publish. The release is cut by tagging the merge
commit (next step), which triggers the Release workflow.
EOF
)"
```

### Step 6 — Wait for CI, then merge

```bash
gh pr checks --watch        # wait until the typecheck check is green
gh pr merge --squash --delete-branch
```

Do not merge while checks are failing. If CI fails, fix on the release branch,
push, and re-watch.

### Step 7 — Tag the merge commit and push

The tag must point at the merged commit on `master`:

```bash
git switch master
git pull --ff-only
git tag -a v<VERSION> -m "v<VERSION>"
git push origin v<VERSION>
```

### Step 8 — Verify the release

Pushing the tag starts the `Release` workflow. Watch it and confirm the Release
exists:

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh release view v<VERSION> --web
```

The 3-OS build matrix takes a while. The release succeeds when the workflow is
green and the Release page lists the platform installers.

## Safety

- Never force-push to `master` and never skip CI.
- If the two manifests disagree before bumping, the helper aborts — resolve the
  mismatch first instead of forcing a version.
- Only tag a commit that already lives on `master` (i.e. after the PR merges),
  so the published binaries match `master`.
