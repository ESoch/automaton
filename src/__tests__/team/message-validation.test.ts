/**
 * Message Validation Tests
 *
 * Validates that team tools produce outputs conforming to expected
 * message formats (WorkRequest-like, WorkClaim-like, WorkResult-like).
 * Also validates artifact envelope structure stored in the database.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient } from "../mocks.js";
import type { AutomatonDatabase, ToolContext } from "../../types.js";
import { createTeamTools } from "../../team/team-tools.js";

function createToolContext(db: AutomatonDatabase, address?: string): ToolContext {
  const identity = createTestIdentity();
  if (address) identity.address = address as `0x${string}`;
  return {
    identity,
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
}

describe("team message validation", () => {
  let db: AutomatonDatabase;
  let tools: ReturnType<typeof createTeamTools>;

  beforeEach(() => {
    db = createTestDb();
    tools = createTeamTools();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function getTool(name: string) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    return tool;
  }

  describe("task messages", () => {
    it("team_create_task produces a valid task row with all required fields", async () => {
      const ctx = createToolContext(db, "0xOrchestrator");
      await getTool("team_create_task").execute(
        { title: "Build MCP server", description: "Data utility server", priority: 10 },
        ctx,
      );

      const rows = db.raw
        .prepare("SELECT * FROM team_tasks")
        .all() as Array<Record<string, unknown>>;

      expect(rows.length).toBe(1);
      const task = rows[0];

      // Required fields
      expect(task.task_id).toBeTruthy();
      expect(typeof task.task_id).toBe("string");
      expect(task.title).toBe("Build MCP server");
      expect(task.description).toBe("Data utility server");
      expect(task.status).toBe("NEW");
      expect(task.created_by).toBe("0xOrchestrator");
      expect(task.priority).toBe(10);
      expect(task.created_at).toBeTruthy();
      expect(task.payload_json).toBe("{}");
      expect(task.attempt_count).toBe(0);
    });

    it("team_list_tasks returns valid JSON array", async () => {
      const ctx = createToolContext(db);
      await getTool("team_create_task").execute({ title: "Task A" }, ctx);
      await getTool("team_create_task").execute({ title: "Task B" }, ctx);

      const result = await getTool("team_list_tasks").execute({}, ctx);
      const parsed = JSON.parse(result);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);

      // Each task has expected shape
      for (const task of parsed) {
        expect(task).toHaveProperty("task_id");
        expect(task).toHaveProperty("title");
        expect(task).toHaveProperty("status");
        expect(task).toHaveProperty("created_by");
        expect(task).toHaveProperty("priority");
        expect(task).toHaveProperty("created_at");
      }
    });

    it("team_claim_task output contains agent address and lease", async () => {
      const ctx = createToolContext(db, "0xAgent");
      await getTool("team_create_task").execute({ title: "Task" }, ctx);

      const list = JSON.parse(await getTool("team_list_tasks").execute({}, ctx));
      const result = await getTool("team_claim_task").execute(
        { task_id: list[0].task_id },
        ctx,
      );

      expect(result).toMatch(/claimed by 0xAgent/i);
      expect(result).toMatch(/Lease expires:/);
    });

    it("team_complete_task output confirms completion", async () => {
      const ctx = createToolContext(db, "0xAgent");
      await getTool("team_create_task").execute({ title: "Task" }, ctx);

      const list = JSON.parse(await getTool("team_list_tasks").execute({}, ctx));
      await getTool("team_claim_task").execute({ task_id: list[0].task_id }, ctx);

      const result = await getTool("team_complete_task").execute(
        { task_id: list[0].task_id },
        ctx,
      );

      expect(result).toContain("completed");
    });
  });

  describe("artifact envelope", () => {
    it("stored artifact has correct envelope structure", async () => {
      const ctx = createToolContext(db, "0xBuilder");
      const content = {
        title: "Data Validation Server",
        version: "1.0",
        endpoints: ["/validate", "/schema"],
      };

      await getTool("team_store_artifact").execute(
        {
          artifact_type: "design_doc",
          content_json: JSON.stringify(content),
          skip_validation: true,
        },
        ctx,
      );

      const rows = db.raw
        .prepare("SELECT * FROM team_artifacts")
        .all() as Array<Record<string, unknown>>;

      expect(rows.length).toBe(1);
      const artifact = rows[0];

      // Envelope fields
      expect(artifact.artifact_id).toBeTruthy();
      expect(artifact.artifact_type).toBe("design_doc");
      expect(artifact.created_by).toBe("0xBuilder");
      expect(artifact.created_at).toBeTruthy();
      expect(artifact.review_status).toBe("DRAFT");
      expect(artifact.hash).toBeTruthy();
      expect(typeof artifact.hash).toBe("string");
      expect((artifact.hash as string).length).toBe(64); // SHA-256 hex

      // Content is valid JSON
      const parsed = JSON.parse(artifact.content_json as string);
      expect(parsed).toEqual(content);

      // Approved-by is empty array
      expect(JSON.parse(artifact.approved_by_json as string)).toEqual([]);
    });

    it("rejects invalid JSON content", async () => {
      const ctx = createToolContext(db);

      const result = await getTool("team_store_artifact").execute(
        {
          artifact_type: "report",
          content_json: "not valid json{{{",
        },
        ctx,
      );

      expect(result).toContain("Error");
      expect(result).toContain("not valid JSON");
    });

    it("team_fetch_artifact returns full artifact as JSON", async () => {
      const ctx = createToolContext(db);
      await getTool("team_store_artifact").execute(
        {
          artifact_type: "eval_report",
          content_json: JSON.stringify({ score: 95 }),
          skip_validation: true,
        },
        ctx,
      );

      const stored = db.raw
        .prepare("SELECT artifact_id FROM team_artifacts")
        .get() as { artifact_id: string };

      const result = await getTool("team_fetch_artifact").execute(
        { artifact_id: stored.artifact_id },
        ctx,
      );

      const parsed = JSON.parse(result);
      expect(parsed.artifact_id).toBe(stored.artifact_id);
      expect(parsed.artifact_type).toBe("eval_report");
      expect(parsed.review_status).toBe("DRAFT");
    });

    it("team_fetch_artifact returns error for non-existent artifact", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_fetch_artifact").execute(
        { artifact_id: "does-not-exist" },
        ctx,
      );

      expect(result).toContain("not found");
    });

    it("team_search_artifacts returns filtered results", async () => {
      const ctx = createToolContext(db, "0xBuilder");
      await getTool("team_store_artifact").execute(
        { artifact_type: "design_doc", content_json: '{"a": 1}', skip_validation: true },
        ctx,
      );
      await getTool("team_store_artifact").execute(
        { artifact_type: "eval_report", content_json: '{"b": 2}', skip_validation: true },
        ctx,
      );

      const result = await getTool("team_search_artifacts").execute(
        { artifact_type: "design_doc" },
        ctx,
      );

      const parsed = JSON.parse(result);
      expect(parsed.length).toBe(1);
      expect(parsed[0].artifact_type).toBe("design_doc");
    });
  });

  describe("approval messages", () => {
    it("team_request_approval creates a valid approval record", async () => {
      const ctx = createToolContext(db, "0xBuilder");

      const result = await getTool("team_request_approval").execute(
        {
          action_type: "deploy",
          action_description: "Deploy v1 to production",
          action_payload: JSON.stringify({ target: "prod" }),
          risk_assessment: "HIGH",
        },
        ctx,
      );

      expect(result).toContain("Approval requested:");
      expect(result).toContain("PENDING");

      const rows = db.raw
        .prepare("SELECT * FROM team_approvals")
        .all() as Array<Record<string, unknown>>;

      expect(rows.length).toBe(1);
      expect(rows[0].requested_by).toBe("0xBuilder");
      expect(rows[0].action_type).toBe("deploy");
      expect(rows[0].status).toBe("PENDING");
      expect(rows[0].risk_assessment).toBe("HIGH");
    });

    it("team_request_approval rejects invalid payload JSON", async () => {
      const ctx = createToolContext(db);

      const result = await getTool("team_request_approval").execute(
        {
          action_type: "deploy",
          action_description: "Deploy",
          action_payload: "not{json",
        },
        ctx,
      );

      expect(result).toContain("Error");
      expect(result).toContain("not valid JSON");
    });
  });

  describe("event messages", () => {
    it("team_broadcast_status creates a valid event record", async () => {
      const ctx = createToolContext(db, "0xQA");
      db.setKV("team.role", "qa-evals");

      await getTool("team_broadcast_status").execute(
        {
          current_task: "Running eval suite",
          progress_percent: 75,
          blockers: "Waiting for test data",
          last_artifact: "artifact-456",
        },
        ctx,
      );

      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'STATUS_BROADCAST'")
        .all() as Array<Record<string, unknown>>;

      expect(events.length).toBe(1);
      expect(events[0].agent_id).toBe("0xQA");
      expect(events[0].agent_role).toBe("qa-evals");

      const payload = JSON.parse(events[0].payload_json as string);
      expect(payload.currentTask).toBe("Running eval suite");
      expect(payload.progressPercent).toBe(75);
      expect(payload.blockers).toBe("Waiting for test data");
      expect(payload.lastArtifact).toBe("artifact-456");
    });

    it("team_direct_message creates a valid event record with target", async () => {
      const ctx = createToolContext(db, "0xSecurity");
      db.setKV("team.role", "security-compliance");

      await getTool("team_direct_message").execute(
        {
          target_agent_id: "0xBuilder",
          message_type: "review_request",
          content: "Permission escalation risk in endpoint /admin",
        },
        ctx,
      );

      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'DIRECT_MESSAGE'")
        .all() as Array<Record<string, unknown>>;

      expect(events.length).toBe(1);
      expect(events[0].agent_id).toBe("0xSecurity");
      expect(events[0].target_agent_id).toBe("0xBuilder");

      const payload = JSON.parse(events[0].payload_json as string);
      expect(payload.messageType).toBe("review_request");
      expect(payload.content).toContain("Permission escalation");
    });
  });
});
