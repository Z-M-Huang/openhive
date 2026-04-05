---
name: release
description: Create a GitHub release from package.json version, auto-generate notes, and push Docker image to Docker Hub.
user-invocable: true
---

# Release

Create a GitHub release and push the Docker image to Docker Hub.

**Run every step in order. Stop immediately on any failure.**

## Step 1: Pre-flight — Clean Working Tree

```bash
git status --porcelain
```

If there is ANY output (uncommitted or untracked changes), **STOP** and tell the user:
> Uncommitted changes detected. Please commit or stash before releasing.

Do NOT proceed.

## Step 2: Pre-flight — No Unpushed Commits

```bash
git log origin/main..HEAD --oneline
```

If there is ANY output (unpushed commits), **STOP** and tell the user:
> Unpushed commits detected. Please push before releasing.

Do NOT proceed.

## Step 3: Read Version

```bash
node -p "require('./package.json').version"
```

Store this as `VERSION`. The release tag will be `v{VERSION}`.

## Step 4: Check for Existing Release

```bash
gh release view "v{VERSION}" 2>&1
```

**If the release exists**, ask the user:

> Release `v{VERSION}` already exists. What would you like to do?
> 1. **Delete and recreate** — delete the existing release/tag and recreate at current HEAD
> 2. **Bump version** — choose a new version number

- If **delete and recreate**: run these commands, then continue to Step 5:
  ```bash
  gh release delete "v{VERSION}" --yes
  git push origin :refs/tags/v{VERSION}
  git tag -d v{VERSION}
  ```

- If **bump version**: ask the user what version they want to bump to (show current version for reference). Then:
  1. Update `version` in `package.json` to the new version
  2. Commit: `chore: bump version to {NEW_VERSION}`
  3. Push the commit
  4. Update `VERSION` to the new value and continue to Step 5

**If the release does NOT exist**, continue to Step 5.

## Step 5: Find Previous Release Tag

```bash
gh release list --limit 1 --json tagName --jq '.[0].tagName'
```

If no previous release exists, use the root commit:
```bash
git rev-list --max-parents=0 HEAD
```

Store this as `PREV_TAG`.

## Step 6: Auto-generate Release Notes

Gather commit log since previous release:
```bash
git log {PREV_TAG}..HEAD --pretty=format:'%h %s'
```

And the diff stat:
```bash
git diff {PREV_TAG}..HEAD --stat
```

Read the full commit messages for detail:
```bash
git log {PREV_TAG}..HEAD --pretty=format:'%B---'
```

From these, compose release notes in this format:

```markdown
## What's New

{Organize changes into logical sections based on commit content.
Group related changes under descriptive ### headings.
Use bullet points. Be specific — reference tools, tables, files by name.
Summarize what changed and why, don't just repeat commit subjects.}

**Full Changelog**: https://github.com/Z-M-Huang/openhive/compare/{PREV_TAG}...v{VERSION}
```

Show the draft release notes to the user and ask for confirmation before creating.

## Step 7: Create Tag and GitHub Release

```bash
git tag v{VERSION}
git push origin v{VERSION}
gh release create "v{VERSION}" --title "OpenHive v{VERSION} — {SHORT_TITLE}" --notes "{RELEASE_NOTES}"
```

`{SHORT_TITLE}` should be a concise summary of the main theme of this release (e.g., "SQLite-Only Memory System", "Multi-Topic Routing").

Print the release URL when done.

## Step 8: Docker Build and Push

```bash
bash deployments/build-push.sh --push
```

This builds and pushes `zhironghuang/openhive:{VERSION}` and `zhironghuang/openhive:latest` to Docker Hub.

If the build or push fails, **tell the user immediately** — the GitHub release was already created so they may need to manually clean up.

## Step 9: Report

```
=== Release Report ===
Version:  v{VERSION}
Tag:      v{VERSION} @ {COMMIT_SHA}
Release:  {RELEASE_URL}
Docker:   zhironghuang/openhive:{VERSION}
          zhironghuang/openhive:latest
```
