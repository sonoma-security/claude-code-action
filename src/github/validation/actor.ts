#!/usr/bin/env bun

/**
 * Check if the action trigger is from a human actor
 * Prevents automated tools or bots from triggering Claude
 */

import type { Octokit } from "@octokit/rest";
import type { GitHubContext } from "../context";
import { getAllowedBotPrAuthor, isAllowedBot } from "./allowed-bots";

export async function checkHumanActor(
  octokit: Octokit,
  githubContext: GitHubContext,
) {
  const allowedBots = githubContext.inputs.allowedBots;

  // PR-author bypass: when this is a pull_request* event and the PR was
  // authored by a login in allowed_bots, the workflow's `if:` has already
  // authorized it on PR-author identity. The triggering actor is irrelevant
  // (it may be a human teammate who locally pushed a follow-up commit to a
  // bot-authored branch). Skip the user-lookup entirely. See
  // getAllowedBotPrAuthor for the full rationale.
  const botPrAuthor = getAllowedBotPrAuthor(githubContext, allowedBots);
  if (botPrAuthor) {
    console.log(
      `PR author ${botPrAuthor} is in allowed_bots; skipping human actor check (triggering actor: ${githubContext.actor})`,
    );
    return;
  }

  const actor = githubContext.actor;

  // Resolve the actor's account type before consulting allowed_bots so the
  // allow-list only ever applies to non-User accounts. Some app actors
  // (e.g. GitHub Copilot with GITHUB_ACTOR="Copilot") are not resolvable
  // via the Users API and 404 — that path is handled in the catch below.
  let actorType: string;
  try {
    const { data: userData } = await octokit.users.getByUsername({
      username: actor,
    });
    actorType = userData.type;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Not Found") ||
        error.message.includes("is not a user"))
    ) {
      // Unresolvable actors are GitHub Apps without a backing user account.
      if (isAllowedBot(actor, allowedBots)) {
        console.log(
          `Actor ${actor} is in allowed_bots list, skipping human actor check`,
        );
        return;
      }
      const botName = actor.toLowerCase().replace(/\[bot\]$/, "");
      throw new Error(
        `Workflow initiated by non-human actor: ${botName} (actor not found on GitHub). Add bot to allowed_bots list or use '*' to allow all bots.`,
      );
    }
    throw error;
  }

  console.log(`Actor type: ${actorType}`);

  if (actorType !== "User") {
    // GitHub Apps and other bot accounts.
    if (isAllowedBot(actor, allowedBots)) {
      console.log(
        `Actor ${actor} is in allowed_bots list, skipping human actor check`,
      );
      return;
    }
    const botName = actor.toLowerCase().replace(/\[bot\]$/, "");
    throw new Error(
      `Workflow initiated by non-human actor: ${botName} (type: ${actorType}). Add bot to allowed_bots list or use '*' to allow all bots.`,
    );
  }

  // Regular User account. allowed_bots is only for bot actors and is not
  // consulted here; write-access enforcement for users happens separately
  // in checkWritePermissions.
  console.log(`Verified human actor: ${actor}`);
}
