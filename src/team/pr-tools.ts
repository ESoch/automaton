/**
 * PR Tools
 *
 * Two tools for agents to push changes back to the repo via pull requests.
 * create_pull_request requires human approval via the approval gate.
 * sync_workspace is a simple fetch/pull with no approval needed.
 *
 * Mirrors the publish-tools.ts pattern: approval-gated, event-logged.
 */

import { writeFileSync, unlinkSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { ulid } from "ulid";
import type { AutomatonTool, ToolContext } from "../types.js";
import { requestApproval, checkApproval } from "./approval-gate.js";

// ─── Validation ──────────────────────────────────────────────

const BRANCH_NAME_RE = /^[a-zA-Z0-9\/_.-]+$/;

function validateBranchName(branch: string): string | null {
  if (!branch || branch.length === 0) return "Branch name is required";
  if (branch.length > 200) return "Branch name too long (max 200 chars)";
  if (!BRANCH_NAME_RE.test(branch)) return `Invalid branch name: must match ${BRANCH_NAME_RE}`;
  if (branch === "main" || branch === "master") return "Cannot create PR from protected branch";
  return null;
}

// ─── Shared approval flow ─────────────────────────────────────

interface ApprovalCheck {
  proceed: boolean;
  message: string;
}

async function handleApproval(
  ctx: ToolContext,
  approvalId: string | undefined,
  title: string,
  branch: string,
  base: string,
): Promise<ApprovalCheck> {
  if (!approvalId) {
    const id = await requestApproval(ctx.db.raw, {
      requestedBy: ctx.identity.address,
      actionType: "CREATE_PULL_REQUEST",
      actionDescription: `Create PR: "${title}" (${branch} → ${base})`,
      actionPayload: { title, branch, base },
      riskAssessment: "Creating a pull request on GitHub — requires human review before merge",
    });
    return { proceed: false, message: `Approval requested: ${id} — awaiting human approval before creating PR.` };
  }

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
  return { proceed: true, message: "" };
}

// ─── Event logging ────────────────────────────────────────────

function logPrEvent(
  ctx: ToolContext,
  payload: Record<string, unknown>,
): void {
  const agentRole = ctx.db.getKV("team.role") ?? "unknown";
  ctx.db.raw
    .prepare(
      `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, payload_json)
       VALUES (?, 'CREATE_PR', ?, ?, ?)`,
    )
    .run(ulid(), ctx.identity.address, agentRole, JSON.stringify(payload));
}

// ─── Git helpers ──────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
}

function gh(args: string[], cwd: string, env?: Record<string, string>): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  }).trim();
}

// ─── Tool definitions ─────────────────────────────────────────

export function createPrTools(): AutomatonTool[] {
  return [
    // ── create_pull_request ──
    {
      name: "create_pull_request",
      description:
        "Create a GitHub pull request from a branch in the workspace. Requires human approval. " +
        "First call without approval_id to request approval, then call again with the returned approval_id after approval.",
      category: "git",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "PR title (max 80 chars).",
          },
          body: {
            type: "string",
            description: "PR description with summary and test plan.",
          },
          branch: {
            type: "string",
            description: "Source branch name (must exist in workspace).",
          },
          base: {
            type: "string",
            description: "Target branch (default: main).",
          },
          repo_path: {
            type: "string",
            description: "Path to the git repo (default: /workspace/repo).",
          },
          approval_id: {
            type: "string",
            description: "Approval ID from a previous request. Omit to request new approval.",
          },
        },
        required: ["title", "body", "branch"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const title = (args.title as string).slice(0, 80);
        const body = args.body as string;
        const branch = args.branch as string;
        const base = (args.base as string) ?? "main";
        const repoPath = (args.repo_path as string) ?? "/workspace/repo";
        const approvalId = args.approval_id as string | undefined;

        // Validate branch name
        const branchErr = validateBranchName(branch);
        if (branchErr) return `Error: ${branchErr}`;

        // Validate base is main
        if (base !== "main") return "Error: base branch must be 'main'";

        // Validate repo exists
        if (!existsSync(join(repoPath, ".git"))) {
          return "Error: workspace repo not found. Is the workspace volume mounted?";
        }

        // Verify the branch exists locally
        try {
          git(["rev-parse", "--verify", branch], repoPath);
        } catch {
          return `Error: branch '${branch}' does not exist in workspace. Create it first with git.`;
        }

        // Approval gate
        const approval = await handleApproval(ctx, approvalId, title, branch, base);
        if (!approval.proceed) return approval.message;

        // Push branch to origin
        const ghToken = process.env.GH_TOKEN;
        if (!ghToken) return "Error: GH_TOKEN not configured";

        try {
          git(["push", "--force-with-lease", "origin", `${branch}:${branch}`], repoPath);
        } catch (err: any) {
          return `Error pushing branch: ${err.message}`;
        }

        // Create PR via gh CLI — write body to temp file to prevent shell injection
        const bodyFile = join(repoPath, ".pr-body-tmp");
        try {
          writeFileSync(bodyFile, body, "utf-8");
          const result = gh(
            ["pr", "create", "--title", title, "--body-file", bodyFile, "--base", base, "--head", branch],
            repoPath,
            { GH_TOKEN: ghToken },
          );

          logPrEvent(ctx, { title, branch, base, prUrl: result });

          return `Pull request created: ${result}`;
        } catch (err: any) {
          return `Error creating PR: ${err.message}`;
        } finally {
          try { unlinkSync(bodyFile); } catch { /* ignore */ }
        }
      },
    },

    // ── sync_workspace ──
    {
      name: "sync_workspace",
      description:
        "Pull latest changes from origin into the workspace. Runs git fetch + fast-forward pull on main.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          repo_path: {
            type: "string",
            description: "Path to the git repo (default: /workspace/repo).",
          },
        },
        required: [],
      },
      execute: async (
        args: Record<string, unknown>,
      ): Promise<string> => {
        const repoPath = (args.repo_path as string) ?? "/workspace/repo";

        if (!existsSync(join(repoPath, ".git"))) {
          return "Error: workspace repo not found. Is the workspace volume mounted?";
        }

        try {
          git(["fetch", "origin"], repoPath);
          const pullResult = git(["pull", "origin", "main", "--ff-only"], repoPath);

          // Update submodules
          try {
            git(["submodule", "update", "--init", "--recursive"], repoPath);
          } catch { /* submodule update is best-effort */ }

          return `Workspace synced.\n${pullResult}`;
        } catch (err: any) {
          return `Error syncing workspace: ${err.message}`;
        }
      },
    },
  ];
}
