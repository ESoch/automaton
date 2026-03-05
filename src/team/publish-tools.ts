/**
 * Publish Tools
 *
 * Three tools for the Chronicler agent to publish content to X, Threads,
 * and LinkedIn. All tools require human approval via the approval gate
 * before any API call is made.
 *
 * Token refresh is handled automatically when tokens are expired.
 */

import { ulid } from "ulid";
import type { AutomatonTool, ToolContext } from "../types.js";
import { requestApproval, checkApproval } from "./approval-gate.js";

// ─── Env helpers ──────────────────────────────────────────────

function getEnv(key: string): string | undefined {
  return process.env[key];
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// ─── Shared approval flow ─────────────────────────────────────

interface ApprovalCheck {
  proceed: boolean;
  message: string;
}

async function handleApproval(
  ctx: ToolContext,
  approvalId: string | undefined,
  platform: string,
  content: string,
): Promise<ApprovalCheck> {
  if (!approvalId) {
    // Request new approval
    const id = await requestApproval(ctx.db.raw, {
      requestedBy: ctx.identity.address,
      actionType: `PUBLISH_${platform.toUpperCase()}`,
      actionDescription: `Publish to ${platform}: ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`,
      actionPayload: { platform, content },
      riskAssessment: "Publishing content publicly — requires human review",
    });
    return { proceed: false, message: `Approval requested: ${id} — awaiting human approval before publishing.` };
  }

  // Check existing approval
  const { status, humanNotes } = await checkApproval(ctx.db.raw, approvalId);

  if (status === "PENDING") {
    return { proceed: false, message: `Approval ${approvalId} is still awaiting human review.` };
  }
  if (status === "DENIED") {
    return { proceed: false, message: `Approval ${approvalId} was denied${humanNotes ? `: ${humanNotes}` : ""}` };
  }
  if (status === "NOT_FOUND") {
    return { proceed: false, message: `Approval ${approvalId} not found.` };
  }
  // APPROVED
  return { proceed: true, message: "" };
}

// ─── Event logging ────────────────────────────────────────────

function logPublishEvent(
  ctx: ToolContext,
  platform: string,
  payload: Record<string, unknown>,
): void {
  const agentRole = ctx.db.getKV("team.role") ?? "unknown";
  ctx.db.raw
    .prepare(
      `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, payload_json)
       VALUES (?, 'PUBLISH', ?, ?, ?)`,
    )
    .run(ulid(), ctx.identity.address, agentRole, JSON.stringify({ platform, ...payload }));
}

// ─── X (Twitter) ──────────────────────────────────────────────

async function refreshXToken(): Promise<string> {
  const refreshToken = requireEnv("X_REFRESH_TOKEN");
  const clientId = requireEnv("X_CLIENT_ID");
  const clientSecret = requireEnv("X_CLIENT_SECRET");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  process.env.X_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) {
    process.env.X_REFRESH_TOKEN = data.refresh_token;
  }
  process.env.X_TOKEN_EXPIRES_AT = new Date(
    Date.now() + data.expires_in * 1000,
  ).toISOString();

  return data.access_token;
}

async function getXToken(): Promise<string> {
  const token = getEnv("X_ACCESS_TOKEN");
  const expiresAt = getEnv("X_TOKEN_EXPIRES_AT");

  if (!token) throw new Error("Missing X_ACCESS_TOKEN — run: pnpm oauth:x");

  if (expiresAt && new Date(expiresAt) < new Date()) {
    return refreshXToken();
  }

  return token;
}

async function postTweet(
  accessToken: string,
  text: string,
  replyToId?: string,
): Promise<string> {
  const body: Record<string, unknown> = { text };
  if (replyToId) {
    body.reply = { in_reply_to_tweet_id: replyToId };
  }

  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`X API error (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as { data: { id: string; text: string } };
  return data.data.id;
}

// ─── Threads ──────────────────────────────────────────────────

async function refreshThreadsToken(): Promise<string> {
  const token = requireEnv("THREADS_ACCESS_TOKEN");

  const url = new URL("https://graph.threads.net/refresh_access_token");
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Threads token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  process.env.THREADS_ACCESS_TOKEN = data.access_token;
  process.env.THREADS_TOKEN_EXPIRES_AT = new Date(
    Date.now() + data.expires_in * 1000,
  ).toISOString();

  return data.access_token;
}

async function getThreadsToken(): Promise<string> {
  const token = getEnv("THREADS_ACCESS_TOKEN");
  const expiresAt = getEnv("THREADS_TOKEN_EXPIRES_AT");

  if (!token) throw new Error("Missing THREADS_ACCESS_TOKEN — run: pnpm oauth:threads");

  if (expiresAt && new Date(expiresAt) < new Date()) {
    return refreshThreadsToken();
  }

  return token;
}

// ─── LinkedIn ─────────────────────────────────────────────────

async function refreshLinkedInToken(): Promise<string> {
  const refreshToken = requireEnv("LINKEDIN_REFRESH_TOKEN");
  const clientId = requireEnv("LINKEDIN_CLIENT_ID");
  const clientSecret = requireEnv("LINKEDIN_CLIENT_SECRET");

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LinkedIn token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  process.env.LINKEDIN_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) {
    process.env.LINKEDIN_REFRESH_TOKEN = data.refresh_token;
  }
  process.env.LINKEDIN_TOKEN_EXPIRES_AT = new Date(
    Date.now() + data.expires_in * 1000,
  ).toISOString();

  return data.access_token;
}

async function getLinkedInToken(): Promise<string> {
  const token = getEnv("LINKEDIN_ACCESS_TOKEN");
  const expiresAt = getEnv("LINKEDIN_TOKEN_EXPIRES_AT");

  if (!token) throw new Error("Missing LINKEDIN_ACCESS_TOKEN — run: pnpm oauth:linkedin");

  if (expiresAt && new Date(expiresAt) < new Date()) {
    return refreshLinkedInToken();
  }

  return token;
}

// ─── Tool definitions ─────────────────────────────────────────

export function createPublishTools(): AutomatonTool[] {
  return [
    // ── publish_x ──
    {
      name: "publish_x",
      description:
        "Publish a tweet or thread to X (Twitter). Requires human approval. " +
        "Pass content as a string for a single tweet, or a JSON array of strings for a thread.",
      category: "publishing",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Tweet text (single) or JSON array of strings (thread). Max 280 chars per tweet.",
          },
          approval_id: {
            type: "string",
            description: "Approval ID from a previous request. Omit to request new approval.",
          },
        },
        required: ["content"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const content = args.content as string;
        const approvalId = args.approval_id as string | undefined;

        const approval = await handleApproval(ctx, approvalId, "X", content);
        if (!approval.proceed) return approval.message;

        const accessToken = await getXToken();

        // Determine if single tweet or thread
        let tweets: string[];
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            tweets = parsed.map(String);
          } else {
            tweets = [content];
          }
        } catch {
          tweets = [content];
        }

        const tweetIds: string[] = [];
        let previousId: string | undefined;

        for (const text of tweets) {
          const id = await postTweet(accessToken, text, previousId);
          tweetIds.push(id);
          previousId = id;
        }

        logPublishEvent(ctx, "X", {
          tweetIds,
          isThread: tweets.length > 1,
          tweetCount: tweets.length,
        });

        if (tweets.length === 1) {
          return `Published tweet: https://x.com/i/status/${tweetIds[0]}`;
        }
        return `Published thread (${tweets.length} tweets). First: https://x.com/i/status/${tweetIds[0]}`;
      },
    },

    // ── publish_threads ──
    {
      name: "publish_threads",
      description:
        "Publish a text post to Threads. Requires human approval. Max 500 characters.",
      category: "publishing",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Post text (max 500 characters).",
          },
          approval_id: {
            type: "string",
            description: "Approval ID from a previous request. Omit to request new approval.",
          },
        },
        required: ["content"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const content = args.content as string;
        const approvalId = args.approval_id as string | undefined;

        if (content.length > 500) {
          return `Content too long: ${content.length} chars (max 500).`;
        }

        const approval = await handleApproval(ctx, approvalId, "Threads", content);
        if (!approval.proceed) return approval.message;

        const accessToken = await getThreadsToken();
        const userId = requireEnv("THREADS_USER_ID");

        // Step 1: Create media container
        const createRes = await fetch(
          `https://graph.threads.net/v1.0/${userId}/threads`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              media_type: "TEXT",
              text: content,
              access_token: accessToken,
            }),
          },
        );

        if (!createRes.ok) {
          const errBody = await createRes.text();
          throw new Error(`Threads create failed (${createRes.status}): ${errBody}`);
        }

        const { id: creationId } = (await createRes.json()) as { id: string };

        // Step 2: Publish
        const publishRes = await fetch(
          `https://graph.threads.net/v1.0/${userId}/threads_publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              creation_id: creationId,
              access_token: accessToken,
            }),
          },
        );

        if (!publishRes.ok) {
          const errBody = await publishRes.text();
          throw new Error(`Threads publish failed (${publishRes.status}): ${errBody}`);
        }

        const { id: postId } = (await publishRes.json()) as { id: string };

        logPublishEvent(ctx, "Threads", { postId });

        return `Published to Threads: post ID ${postId}`;
      },
    },

    // ── publish_linkedin ──
    {
      name: "publish_linkedin",
      description:
        "Publish a post to LinkedIn. Requires human approval.",
      category: "publishing",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Post text/commentary.",
          },
          approval_id: {
            type: "string",
            description: "Approval ID from a previous request. Omit to request new approval.",
          },
        },
        required: ["content"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const content = args.content as string;
        const approvalId = args.approval_id as string | undefined;

        const approval = await handleApproval(ctx, approvalId, "LinkedIn", content);
        if (!approval.proceed) return approval.message;

        const accessToken = await getLinkedInToken();
        const personUrn = requireEnv("LINKEDIN_PERSON_URN");

        const res = await fetch("https://api.linkedin.com/rest/posts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "X-Restli-Protocol-Version": "2.0.0",
            "LinkedIn-Version": "202401",
          },
          body: JSON.stringify({
            author: `urn:li:person:${personUrn}`,
            lifecycleState: "PUBLISHED",
            visibility: "PUBLIC",
            commentary: content,
            distribution: {
              feedDistribution: "MAIN_FEED",
            },
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`LinkedIn API error (${res.status}): ${errBody}`);
        }

        // LinkedIn returns 201 with x-restli-id header
        const postId = res.headers.get("x-restli-id") ?? "unknown";

        logPublishEvent(ctx, "LinkedIn", { postId });

        return `Published to LinkedIn: post ID ${postId}`;
      },
    },
  ];
}
