/**
 * Team Tools
 *
 * 10 tools for cross-agent task coordination, artifact management,
 * approval workflows, and team communication. All operations are
 * backed by the team_* tables introduced in MIGRATION_V11.
 */

import { createHash } from "crypto";
import { ulid } from "ulid";
import type { AutomatonTool, ToolContext } from "../types.js";
import { validateArtifactContent } from "./artifact-validator.js";

/**
 * Create all team coordination tools.
 * These are added to the builtin tools array in tools.ts.
 */
export function createTeamTools(): AutomatonTool[] {
  return [
    // ── 1. team_create_task ──
    {
      name: "team_create_task",
      description:
        "Create a task in the team task queue for another agent to claim. " +
        "Tasks are visible to all agents sharing the same database.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: {
            type: "string",
            description: "Detailed task description",
          },
          priority: {
            type: "number",
            description: "Priority (lower = higher priority, default: 100)",
          },
          assign_to: {
            type: "string",
            description: "Optional agent address to assign to directly",
          },
          payload: {
            type: "string",
            description: "Optional JSON payload with extra data",
          },
        },
        required: ["title"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const taskId = ulid();
        const title = args.title as string;
        const description = (args.description as string) ?? null;
        const priority = (args.priority as number) ?? 100;
        const assignTo = (args.assign_to as string) ?? null;
        const payload = (args.payload as string) ?? "{}";

        ctx.db.raw
          .prepare(
            `INSERT INTO team_tasks (task_id, title, description, priority, created_by, assigned_to, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            title,
            description,
            priority,
            ctx.identity.address,
            assignTo,
            payload,
          );

        return `Task created: ${taskId} — "${title}" (priority: ${priority}${assignTo ? `, assigned: ${assignTo}` : ""})`;
      },
    },

    // ── 2. team_list_tasks ──
    {
      name: "team_list_tasks",
      description:
        "List tasks in the team task queue. Optionally filter by status.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Filter by status: NEW, CLAIMED, IN_PROGRESS, DONE, FAILED (optional)",
          },
          limit: {
            type: "number",
            description: "Max results (default: 50)",
          },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const status = args.status as string | undefined;
        const limit = (args.limit as number) ?? 50;

        let rows: unknown[];
        if (status) {
          rows = ctx.db.raw
            .prepare(
              "SELECT * FROM team_tasks WHERE status = ? ORDER BY priority ASC, created_at ASC LIMIT ?",
            )
            .all(status, limit);
        } else {
          rows = ctx.db.raw
            .prepare(
              "SELECT * FROM team_tasks ORDER BY priority ASC, created_at ASC LIMIT ?",
            )
            .all(limit);
        }

        if ((rows as unknown[]).length === 0) {
          return status
            ? `No tasks with status "${status}".`
            : "No tasks in the queue.";
        }

        return JSON.stringify(rows, null, 2);
      },
    },

    // ── 3. team_claim_task ──
    {
      name: "team_claim_task",
      description:
        "Claim (lease) a task from the queue. Sets assigned_to and lease expiry. " +
        "Only NEW tasks can be claimed.",
      category: "memory",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to claim" },
          lease_seconds: {
            type: "number",
            description: "Lease duration in seconds (default: 3600)",
          },
        },
        required: ["task_id"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const taskId = args.task_id as string;
        const leaseSeconds = (args.lease_seconds as number) ?? 3600;
        const leaseExpiresAt = new Date(
          Date.now() + leaseSeconds * 1000,
        ).toISOString();

        const result = ctx.db.raw
          .prepare(
            `UPDATE team_tasks
             SET status = 'CLAIMED', assigned_to = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
             WHERE task_id = ? AND status = 'NEW'`,
          )
          .run(ctx.identity.address, leaseExpiresAt, taskId);

        if (result.changes === 0) {
          return `Failed to claim task ${taskId}: not found or not in NEW status.`;
        }

        return `Task ${taskId} claimed by ${ctx.identity.address}. Lease expires: ${leaseExpiresAt}`;
      },
    },

    // ── 4. team_complete_task ──
    {
      name: "team_complete_task",
      description:
        "Mark a task as DONE. Optionally attach an artifact ID as the deliverable.",
      category: "memory",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to complete" },
          artifact_id: {
            type: "string",
            description: "Optional artifact ID for the deliverable",
          },
        },
        required: ["task_id"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const taskId = args.task_id as string;
        const artifactId = (args.artifact_id as string) ?? null;

        const result = ctx.db.raw
          .prepare(
            `UPDATE team_tasks
             SET status = 'DONE', artifact_id = ?
             WHERE task_id = ? AND assigned_to = ?`,
          )
          .run(artifactId, taskId, ctx.identity.address);

        if (result.changes === 0) {
          return `Failed to complete task ${taskId}: not found or not assigned to you.`;
        }

        return `Task ${taskId} completed.${artifactId ? ` Artifact: ${artifactId}` : ""}`;
      },
    },

    // ── 5. team_store_artifact ──
    {
      name: "team_store_artifact",
      description:
        "Store a work artifact (design doc, code, report, etc.) for team review.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          artifact_type: {
            type: "string",
            description:
              "Type of artifact: design_doc, code, report, eval, test_plan, etc.",
          },
          content_json: {
            type: "string",
            description: "JSON string of the artifact content",
          },
          skip_validation: {
            type: "boolean",
            description: "Skip schema validation (for migration/backwards compatibility)",
          },
        },
        required: ["artifact_type", "content_json"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const artifactId = ulid();
        const artifactType = args.artifact_type as string;
        const contentJson = args.content_json as string;

        // Validate JSON
        try {
          JSON.parse(contentJson);
        } catch {
          return "Error: content_json is not valid JSON.";
        }

        // Validate content against schema (unless skipped)
        const skipValidation = args.skip_validation as boolean | undefined;
        if (!skipValidation) {
          const validation = validateArtifactContent(artifactType, contentJson);
          if (!validation.valid) {
            return `Validation error for ${artifactType}: ${validation.errors.join("; ")}`;
          }
        }

        const hash = createHash("sha256")
          .update(contentJson)
          .digest("hex");

        ctx.db.raw
          .prepare(
            `INSERT INTO team_artifacts (artifact_id, artifact_type, created_by, content_json, hash)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(artifactId, artifactType, ctx.identity.address, contentJson, hash);

        return `Artifact stored: ${artifactId} (type: ${artifactType}, hash: ${hash.slice(0, 12)}...)`;
      },
    },

    // ── 6. team_fetch_artifact ──
    {
      name: "team_fetch_artifact",
      description: "Fetch an artifact by its ID.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          artifact_id: {
            type: "string",
            description: "Artifact ID to fetch",
          },
        },
        required: ["artifact_id"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const artifactId = args.artifact_id as string;
        const row = ctx.db.raw
          .prepare("SELECT * FROM team_artifacts WHERE artifact_id = ?")
          .get(artifactId);

        if (!row) {
          return `Artifact ${artifactId} not found.`;
        }

        return JSON.stringify(row, null, 2);
      },
    },

    // ── 7. team_search_artifacts ──
    {
      name: "team_search_artifacts",
      description:
        "Search artifacts by type, review status, or creator.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          artifact_type: {
            type: "string",
            description: "Filter by artifact type (optional)",
          },
          review_status: {
            type: "string",
            description:
              "Filter by review status: DRAFT, IN_REVIEW, APPROVED (optional)",
          },
          created_by: {
            type: "string",
            description: "Filter by creator agent address (optional)",
          },
          limit: {
            type: "number",
            description: "Max results (default: 50)",
          },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (args.artifact_type) {
          conditions.push("artifact_type = ?");
          params.push(args.artifact_type as string);
        }
        if (args.review_status) {
          conditions.push("review_status = ?");
          params.push(args.review_status as string);
        }
        if (args.created_by) {
          conditions.push("created_by = ?");
          params.push(args.created_by as string);
        }

        const limit = (args.limit as number) ?? 50;
        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const rows = ctx.db.raw
          .prepare(
            `SELECT artifact_id, artifact_type, created_at, created_by, hash, review_status
             FROM team_artifacts ${whereClause}
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...params, limit);

        if ((rows as unknown[]).length === 0) {
          return "No artifacts found matching criteria.";
        }

        return JSON.stringify(rows, null, 2);
      },
    },

    // ── 8. team_request_approval ──
    {
      name: "team_request_approval",
      description:
        "Create an approval request for a high-risk action. " +
        "Returns an approval_id that can be polled for resolution.",
      category: "memory",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            description: "Type of action needing approval (e.g., deploy, transfer, publish)",
          },
          action_description: {
            type: "string",
            description: "Human-readable description of the action",
          },
          action_payload: {
            type: "string",
            description: "JSON payload with action details",
          },
          risk_assessment: {
            type: "string",
            description: "Risk assessment: LOW, MEDIUM, HIGH, CRITICAL",
          },
        },
        required: ["action_type", "action_description"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const approvalId = ulid();
        const actionPayload = (args.action_payload as string) ?? "{}";

        // Validate JSON
        try {
          JSON.parse(actionPayload);
        } catch {
          return "Error: action_payload is not valid JSON.";
        }

        ctx.db.raw
          .prepare(
            `INSERT INTO team_approvals (approval_id, requested_by, action_type, action_description, action_payload_json, risk_assessment)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            approvalId,
            ctx.identity.address,
            args.action_type as string,
            (args.action_description as string) ?? null,
            actionPayload,
            (args.risk_assessment as string) ?? null,
          );

        return `Approval requested: ${approvalId} (type: ${args.action_type}, status: PENDING)`;
      },
    },

    // ── 9. team_broadcast_status ──
    {
      name: "team_broadcast_status",
      description:
        "Broadcast your current status to the team event log. " +
        "Other agents can read this to coordinate work.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          current_task: {
            type: "string",
            description: "What you are currently working on",
          },
          progress_percent: {
            type: "number",
            description: "Progress percentage (0-100)",
          },
          blockers: {
            type: "string",
            description: "Any blockers (optional)",
          },
          last_artifact: {
            type: "string",
            description: "ID of most recent artifact produced (optional)",
          },
        },
        required: ["current_task"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const eventId = ulid();
        const payload = {
          currentTask: args.current_task as string,
          progressPercent: (args.progress_percent as number) ?? 0,
          blockers: (args.blockers as string) ?? null,
          lastArtifact: (args.last_artifact as string) ?? null,
        };

        // Determine agent role from KV store
        const agentRole =
          ctx.db.getKV("team.role") ?? "unknown";

        ctx.db.raw
          .prepare(
            `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, payload_json)
             VALUES (?, 'STATUS_BROADCAST', ?, ?, ?)`,
          )
          .run(eventId, ctx.identity.address, agentRole, JSON.stringify(payload));

        return `Status broadcast: ${eventId} — "${payload.currentTask}" (${payload.progressPercent}%)`;
      },
    },

    // ── 10. team_direct_message ──
    {
      name: "team_direct_message",
      description:
        "Send a direct message to another agent, logged in the team event stream. " +
        "Use for coordination, questions, or task handoff.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          target_agent_id: {
            type: "string",
            description: "Target agent's wallet address or ID",
          },
          message_type: {
            type: "string",
            description:
              "Message type: question, answer, handoff, review_request, notification",
          },
          content: {
            type: "string",
            description: "Message content",
          },
        },
        required: ["target_agent_id", "message_type", "content"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const eventId = ulid();
        const targetAgentId = args.target_agent_id as string;
        const messageType = args.message_type as string;
        const content = args.content as string;

        const agentRole =
          ctx.db.getKV("team.role") ?? "unknown";

        const payload = {
          messageType,
          content,
        };

        ctx.db.raw
          .prepare(
            `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, target_agent_id, payload_json)
             VALUES (?, 'DIRECT_MESSAGE', ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            ctx.identity.address,
            agentRole,
            targetAgentId,
            JSON.stringify(payload),
          );

        return `Message sent to ${targetAgentId}: [${messageType}] ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`;
      },
    },

    // ── 11. team_submit_retrospective ──
    {
      name: "team_submit_retrospective",
      description:
        "Submit a retrospective after completing a task. Captures what worked, " +
        "what failed, lessons learned, and action items.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID this retrospective is about",
          },
          what_worked: {
            type: "string",
            description: "JSON array of things that went well",
          },
          what_failed: {
            type: "string",
            description: "JSON array of things that did not go well",
          },
          lessons: {
            type: "string",
            description: "JSON array of key takeaways",
          },
          action_items: {
            type: "string",
            description: "JSON array of specific follow-up actions",
          },
        },
        required: ["task_id"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const retroId = ulid();
        const taskId = args.task_id as string;
        const whatWorked = (args.what_worked as string) ?? "[]";
        const whatFailed = (args.what_failed as string) ?? "[]";
        const lessons = (args.lessons as string) ?? "[]";
        const actionItems = (args.action_items as string) ?? "[]";

        // Verify task exists
        const task = ctx.db.raw
          .prepare("SELECT task_id FROM team_tasks WHERE task_id = ?")
          .get(taskId);
        if (!task) {
          return `Error: task ${taskId} not found.`;
        }

        ctx.db.raw
          .prepare(
            `INSERT INTO team_retrospectives (retro_id, task_id, created_by, what_worked_json, what_failed_json, lessons_json, action_items_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(retroId, taskId, ctx.identity.address, whatWorked, whatFailed, lessons, actionItems);

        // Log event
        const eventId = ulid();
        const agentRole = ctx.db.getKV("team.role") ?? "unknown";
        ctx.db.raw
          .prepare(
            `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, payload_json)
             VALUES (?, 'RETROSPECTIVE', ?, ?, ?)`,
          )
          .run(eventId, ctx.identity.address, agentRole, JSON.stringify({ retroId, taskId }));

        return `Retrospective submitted: ${retroId} for task ${taskId}`;
      },
    },

    // ── 12. team_share_knowledge ──
    {
      name: "team_share_knowledge",
      description:
        "Share a reusable insight or pattern with the team. Stored in the " +
        "team knowledge base for other agents to query.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Knowledge category: technical, market, process, security, integration",
          },
          title: {
            type: "string",
            description: "Short title for this knowledge entry",
          },
          content_json: {
            type: "string",
            description: "JSON string with the knowledge content",
          },
          confidence: {
            type: "number",
            description: "Confidence score (0.0-1.0, default: 0.5)",
          },
        },
        required: ["category", "title", "content_json"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const knowledgeId = ulid();
        const category = args.category as string;
        const title = args.title as string;
        const contentJson = args.content_json as string;
        const confidence = (args.confidence as number) ?? 0.5;

        // Validate JSON
        try {
          JSON.parse(contentJson);
        } catch {
          return "Error: content_json is not valid JSON.";
        }

        const agentRole = ctx.db.getKV("team.role") ?? "unknown";

        ctx.db.raw
          .prepare(
            `INSERT INTO team_knowledge (knowledge_id, created_by, source_role, category, title, content_json, confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(knowledgeId, ctx.identity.address, agentRole, category, title, contentJson, confidence);

        // Log event
        const eventId = ulid();
        ctx.db.raw
          .prepare(
            `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, payload_json)
             VALUES (?, 'KNOWLEDGE_SHARE', ?, ?, ?)`,
          )
          .run(eventId, ctx.identity.address, agentRole, JSON.stringify({ knowledgeId, category, title }));

        return `Knowledge shared: ${knowledgeId} — "${title}" (category: ${category}, confidence: ${confidence})`;
      },
    },

    // ── 13. team_query_knowledge ──
    {
      name: "team_query_knowledge",
      description:
        "Query the team knowledge base by category, keyword, or minimum confidence.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Filter by category (optional)",
          },
          keyword: {
            type: "string",
            description: "Search keyword in title or content (optional)",
          },
          min_confidence: {
            type: "number",
            description: "Minimum confidence score (0.0-1.0, optional)",
          },
          limit: {
            type: "number",
            description: "Max results (default: 20)",
          },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (args.category) {
          conditions.push("category = ?");
          params.push(args.category as string);
        }
        if (args.keyword) {
          conditions.push("(title LIKE ? OR content_json LIKE ?)");
          const kw = `%${args.keyword as string}%`;
          params.push(kw, kw);
        }
        if (args.min_confidence !== undefined) {
          conditions.push("confidence >= ?");
          params.push(args.min_confidence as number);
        }

        const limit = (args.limit as number) ?? 20;
        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const rows = ctx.db.raw
          .prepare(
            `SELECT knowledge_id, category, title, content_json, confidence, use_count, source_role, created_at
             FROM team_knowledge ${whereClause}
             ORDER BY confidence DESC, use_count DESC LIMIT ?`,
          )
          .all(...params, limit);

        if ((rows as unknown[]).length === 0) {
          return "No knowledge entries found matching criteria.";
        }

        // Update use_count for returned entries
        for (const row of rows as Array<{ knowledge_id: string }>) {
          ctx.db.raw
            .prepare(
              `UPDATE team_knowledge SET use_count = use_count + 1, last_used_at = datetime('now') WHERE knowledge_id = ?`,
            )
            .run(row.knowledge_id);
        }

        return JSON.stringify(rows, null, 2);
      },
    },

    // ── 14. team_rate_outcome ──
    {
      name: "team_rate_outcome",
      description:
        "Rate a completed task's outcome. Updates outcome tracking columns " +
        "for learning and strategy adaptation.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to rate",
          },
          score: {
            type: "number",
            description: "Outcome score (1-5, where 5 is best)",
          },
          notes: {
            type: "string",
            description: "Notes about the outcome",
          },
          revenue_generated_cents: {
            type: "number",
            description: "Revenue generated in cents (optional)",
          },
          iterations_required: {
            type: "number",
            description: "Number of iterations/attempts needed (optional)",
          },
        },
        required: ["task_id", "score"],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const taskId = args.task_id as string;
        const score = args.score as number;
        const notes = (args.notes as string) ?? null;
        const revenueCents = (args.revenue_generated_cents as number) ?? 0;
        const iterations = (args.iterations_required as number) ?? 1;

        if (score < 1 || score > 5) {
          return "Error: score must be between 1 and 5.";
        }

        const result = ctx.db.raw
          .prepare(
            `UPDATE team_tasks
             SET outcome_score = ?, outcome_notes = ?, revenue_generated_cents = ?, iterations_required = ?
             WHERE task_id = ?`,
          )
          .run(score, notes, revenueCents, iterations, taskId);

        if (result.changes === 0) {
          return `Error: task ${taskId} not found.`;
        }

        // Log event
        const eventId = ulid();
        const agentRole = ctx.db.getKV("team.role") ?? "unknown";
        ctx.db.raw
          .prepare(
            `INSERT INTO team_events (event_id, event_type, agent_id, agent_role, payload_json)
             VALUES (?, 'OUTCOME_RATED', ?, ?, ?)`,
          )
          .run(eventId, ctx.identity.address, agentRole, JSON.stringify({ taskId, score, revenueCents }));

        return `Outcome rated: task ${taskId} scored ${score}/5${revenueCents > 0 ? ` (revenue: $${(revenueCents / 100).toFixed(2)})` : ""}`;
      },
    },

    // ── 15. team_get_learnings ──
    {
      name: "team_get_learnings",
      description:
        "Retrieve retrospectives and knowledge entries for a given role or task. " +
        "Use before starting work to review past lessons.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Get learnings for a specific task (optional)",
          },
          role: {
            type: "string",
            description: "Get learnings from a specific role (optional)",
          },
          limit: {
            type: "number",
            description: "Max results per category (default: 10)",
          },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<string> => {
        const limit = (args.limit as number) ?? 10;
        const result: { retrospectives: unknown[]; knowledge: unknown[] } = {
          retrospectives: [],
          knowledge: [],
        };

        if (args.task_id) {
          result.retrospectives = ctx.db.raw
            .prepare(
              `SELECT * FROM team_retrospectives WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(args.task_id as string, limit);
        } else if (args.role) {
          // Get retrospectives from agents with this role
          result.retrospectives = ctx.db.raw
            .prepare(
              `SELECT r.* FROM team_retrospectives r
               INNER JOIN team_events e ON e.agent_id = r.created_by AND e.event_type = 'RETROSPECTIVE'
               WHERE e.agent_role = ?
               ORDER BY r.created_at DESC LIMIT ?`,
            )
            .all(args.role as string, limit);

          result.knowledge = ctx.db.raw
            .prepare(
              `SELECT * FROM team_knowledge WHERE source_role = ? ORDER BY confidence DESC, use_count DESC LIMIT ?`,
            )
            .all(args.role as string, limit);
        } else {
          // Get most recent learnings across all roles
          result.retrospectives = ctx.db.raw
            .prepare(
              `SELECT * FROM team_retrospectives ORDER BY created_at DESC LIMIT ?`,
            )
            .all(limit);

          result.knowledge = ctx.db.raw
            .prepare(
              `SELECT * FROM team_knowledge ORDER BY confidence DESC, use_count DESC LIMIT ?`,
            )
            .all(limit);
        }

        if (result.retrospectives.length === 0 && result.knowledge.length === 0) {
          return "No learnings found.";
        }

        return JSON.stringify(result, null, 2);
      },
    },
  ];
}
