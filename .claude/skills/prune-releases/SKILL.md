---
name: prune-releases
description: Clean up GitHub releases/tags and inactive github-pages deployments for the jml-agent-fleet repo, keeping only the most recent few. Use when asked to "prune releases", "clean up old releases/tags", or "prune deployment pages".
---

# Prune releases, tags, and deployments

Repo: `TrickyDanceMoves/jml-agent-fleet`. Keep the release surface tidy without
nuking the current version. Confirm the keep-count with the user if unsure (default:
keep the **latest 2** releases, **latest 3** pages deployments).

## Releases + tags
1. `gh release list --limit 30` and `git ls-remote --tags origin` to see current state.
2. For each release to drop (everything older than the keep set, plus stale drafts):
   `gh release delete <tag> --yes --cleanup-tag` — `--cleanup-tag` removes the git tag too.
3. Leave purely historical milestone tags only if the user wants them; otherwise delete
   remote + local: `git push origin :refs/tags/<tag>` and `git tag -d <tag>`.
4. Verify: `gh release list` and the remote tag list show only the kept versions.

## github-pages deployments
GitHub won't delete an **active** deployment — mark it inactive first.
1. Count: `gh api -X GET "repos/TrickyDanceMoves/jml-agent-fleet/deployments?environment=github-pages&per_page=100" --jq 'length'`.
2. Collect all ids newest-first (paginate), keep the newest 3, prune the rest:
   ```
   gh api --paginate -X GET "repos/TrickyDanceMoves/jml-agent-fleet/deployments?environment=github-pages&per_page=100" --jq '.[].id' > /tmp/dep_ids.txt
   tail -n +4 /tmp/dep_ids.txt > /tmp/dep_prune.txt
   while read -r id; do
     gh api -X POST "repos/TrickyDanceMoves/jml-agent-fleet/deployments/$id/statuses" -f state=inactive >/dev/null 2>&1
     gh api -X DELETE "repos/TrickyDanceMoves/jml-agent-fleet/deployments/$id" >/dev/null 2>&1
   done < /tmp/dep_prune.txt
   ```
3. Verify the remaining count is the kept set (e.g. 3). Report exactly what was deleted.

## Safety
- Never delete the **Latest** release or the live (newest) pages deployment.
- Empty winget husk folders can linger after a version rename — remove only if empty
  (`rmdir`), and only the untracked ones.
