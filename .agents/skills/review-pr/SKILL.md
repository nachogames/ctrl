---
name: review-pr
description: Use when the user asks to review a pull request built in Ctrl, start a review, triage reviews, or run the next review round. Opens the pull request's review session through Ctrl's review_* tools and follows the brief it returns. Not for merging.
---

# Review a pull request

The loop's rules live in the brief that `review_session_open` returns. This skill only gets you there.

1. Find the pull request: `gh pr view --json number,url,headRefOid,state`, or use the number or URL the user gave. Stop if it is not open.
2. Call `t3_group_read`. If it returns `group: null`, your chat is in no group: call `t3_group_create` with no arguments, so the pull request has a group.
3. Call `review_session_open` with `url` and `headSha` set to `headRefOid`. If opening is refused (for example, in a side chat or independent review chat), tell the user and stop. The review belongs to the group. Any ordinary chat in that group can update the same panel, even when `session.reviewThreadId` names another chat. That ID routes panel-triggered automation; it does not own write access. Continue here with the existing session, without creating a duplicate review.
4. Follow the brief. When you are unsure of a rule, call `review_session_open` again; it returns the live review and the brief.

## Requesting Copilot

The brief's "Next round" step points here. This command is not verified; check its result. `gh pr edit --add-reviewer` does not accept bots.

```bash
gh api --method POST "repos/{owner}/{repo}/pulls/$PR/requested_reviewers" \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
gh api "repos/{owner}/{repo}/pulls/$PR/requested_reviewers" --jq '[.users[].login]'
```

Replace `$PR` with the pull request's number. If the first command fails or the second does not list Copilot, ask the user to request Copilot from the pull request's Reviewers menu, and carry on. The Review tab shows Copilot's review once it lands.
