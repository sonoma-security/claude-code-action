import type { GitHubContext } from "../context";
import {
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../context";

/**
 * Check if a bot actor is in the allowed bots list.
 *
 * Matches case-insensitively and ignores any trailing `[bot]` suffix on
 * either side of the comparison, so `allowed_bots: "renovate"` matches an
 * actor named `renovate[bot]` and `allowed_bots: "renovate[bot]"` matches
 * an actor named `renovate`.
 */
export function isAllowedBot(actor: string, allowedBots: string): boolean {
  const trimmed = allowedBots.trim();
  if (trimmed === "*") return true;
  if (!trimmed) return false;

  const allowedList = trimmed
    .split(",")
    .map((bot) =>
      bot
        .trim()
        .toLowerCase()
        .replace(/\[bot\]$/, ""),
    )
    .filter((bot) => bot.length > 0);

  const normalizedActor = actor.toLowerCase().replace(/\[bot\]$/, "");
  return allowedList.includes(normalizedActor);
}

/**
 * For pull_request / pull_request_review / pull_request_review_comment events,
 * return the PR author's login when that login is in the `allowed_bots` list.
 * Otherwise return undefined.
 *
 * Used by checkHumanActor and checkWritePermissions to treat the PR author
 * as the "effective actor" for authorization, instead of the workflow's
 * `GITHUB_ACTOR` (the triggering actor). This handles the case where an
 * autonomous bot opens a PR and a human teammate then pushes a follow-up
 * commit from their local workspace: `GITHUB_ACTOR` becomes the human
 * pusher, and the collaborator-permission lookup against that human 404s
 * for org members who are not directly added as collaborators (e.g. org
 * admins who inherit access via role rather than via the collaborators
 * table), blocking the workflow even though it is authorized.
 *
 * Conceptually, the workflow's `if:` is the authorization gate (it asserts
 * "this PR was authored by a bot we trust"). The triggering actor's repo
 * permissions are not the right signal — the PR-author identity is. When
 * the PR author is in `allowed_bots`, that trust declaration is enough; we
 * skip the triggering-actor permission lookup entirely.
 *
 * `allowed_bots` is opt-in. If the PR author is not listed, this returns
 * undefined and the existing triggering-actor checks run unchanged.
 */
export function getAllowedBotPrAuthor(
  context: GitHubContext,
  allowedBots: string,
): string | undefined {
  if (
    !isPullRequestEvent(context) &&
    !isPullRequestReviewEvent(context) &&
    !isPullRequestReviewCommentEvent(context)
  ) {
    return undefined;
  }
  const prAuthor = context.payload.pull_request?.user?.login;
  if (!prAuthor) return undefined;
  return isAllowedBot(prAuthor, allowedBots) ? prAuthor : undefined;
}
