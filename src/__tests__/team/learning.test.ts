/**
 * Learning System Tests
 *
 * V12 migration, retrospectives, knowledge sharing,
 * outcome rating, and cross-agent learning.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDb,
  createTestIdentity,
  createTestConfig,
  MockConwayClient,
  MockInferenceClient,
} from "../mocks.js";
import type { AutomatonDatabase, ToolContext } from "../../types.js";
import { createTeamTools } from "../../team/team-tools.js";

function createToolContext(
  db: AutomatonDatabase,
  addressOverride?: string,
  role?: string,
): ToolContext {
  const identity = createTestIdentity();
  if (addressOverride) {
    identity.address = addressOverride as `0x${string}`;
  }
  const ctx: ToolContext = {
    identity,
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
  if (role) {
    db.setKV("team.role", role);
  }
  return ctx;
}

describe("learning system", () => {
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

  describe("V12 migration", () => {
    it("creates team_knowledge table", () => {
      const tables = db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='team_knowledge'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });

    it("creates team_retrospectives table", () => {
      const tables = db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='team_retrospectives'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });

    it("adds outcome columns to team_tasks", () => {
      // Insert a task and check the new columns exist
      const ctx = createToolContext(db);
      db.raw
        .prepare(
          `INSERT INTO team_tasks (task_id, title, created_by) VALUES ('test-task', 'Test', 'test')`,
        )
        .run();

      const row = db.raw
        .prepare("SELECT outcome_score, outcome_notes, revenue_generated_cents, iterations_required FROM team_tasks WHERE task_id = 'test-task'")
        .get() as Record<string, unknown>;

      expect(row.outcome_score).toBeNull();
      expect(row.outcome_notes).toBeNull();
      expect(row.revenue_generated_cents).toBe(0);
      expect(row.iterations_required).toBe(1);
    });

    it("creates indices on team_knowledge", () => {
      const indices = db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='team_knowledge'",
        )
        .all() as Array<{ name: string }>;
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).toContain("idx_team_knowledge_category");
      expect(indexNames).toContain("idx_team_knowledge_confidence");
    });
  });

  describe("team_submit_retrospective", () => {
    it("stores retrospective with all fields", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      // Create a task first
      await getTool("team_create_task").execute(
        { title: "Build security scanner" },
        ctx,
      );
      const tasks = JSON.parse(
        await getTool("team_list_tasks").execute({ status: "NEW" }, ctx),
      );
      const taskId = tasks[0].task_id;

      // Submit retrospective
      const result = await getTool("team_submit_retrospective").execute(
        {
          task_id: taskId,
          what_worked: JSON.stringify(["x402 integration was smooth"]),
          what_failed: JSON.stringify(["MCP transport had edge cases"]),
          lessons: JSON.stringify(["Test transport layer first"]),
          action_items: JSON.stringify(["Add transport unit tests"]),
        },
        ctx,
      );

      expect(result).toContain("Retrospective submitted:");
      expect(result).toContain(taskId);

      // Verify in database
      const retros = db.raw
        .prepare("SELECT * FROM team_retrospectives WHERE task_id = ?")
        .all(taskId) as Array<Record<string, unknown>>;
      expect(retros.length).toBe(1);

      const whatWorked = JSON.parse(retros[0].what_worked_json as string);
      expect(whatWorked).toContain("x402 integration was smooth");

      const lessons = JSON.parse(retros[0].lessons_json as string);
      expect(lessons).toContain("Test transport layer first");
    });

    it("rejects retrospective for non-existent task", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_submit_retrospective").execute(
        { task_id: "non-existent-task" },
        ctx,
      );
      expect(result).toContain("Error");
      expect(result).toContain("not found");
    });

    it("logs RETROSPECTIVE event", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      await getTool("team_create_task").execute({ title: "Test task" }, ctx);
      const tasks = JSON.parse(
        await getTool("team_list_tasks").execute({ status: "NEW" }, ctx),
      );

      await getTool("team_submit_retrospective").execute(
        { task_id: tasks[0].task_id },
        ctx,
      );

      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'RETROSPECTIVE'")
        .all() as Array<Record<string, unknown>>;
      expect(events.length).toBe(1);
      expect(events[0].agent_role).toBe("builder-engineer");
    });
  });

  describe("team_share_knowledge", () => {
    it("stores knowledge with confidence score", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      const result = await getTool("team_share_knowledge").execute(
        {
          category: "technical",
          title: "x402 endpoints need CORS headers for browser agents",
          content_json: JSON.stringify({
            pattern: "Add CORS headers to all x402 endpoints",
            example: "Access-Control-Allow-Origin: *",
          }),
          confidence: 0.9,
        },
        ctx,
      );

      expect(result).toContain("Knowledge shared:");
      expect(result).toContain("x402 endpoints need CORS");
      expect(result).toContain("confidence: 0.9");

      // Verify in database
      const entries = db.raw
        .prepare("SELECT * FROM team_knowledge WHERE category = 'technical'")
        .all() as Array<Record<string, unknown>>;
      expect(entries.length).toBe(1);
      expect(entries[0].confidence).toBe(0.9);
      expect(entries[0].source_role).toBe("builder-engineer");
    });

    it("rejects invalid JSON content", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_share_knowledge").execute(
        {
          category: "technical",
          title: "Test",
          content_json: "not json{{{",
        },
        ctx,
      );
      expect(result).toContain("Error");
      expect(result).toContain("not valid JSON");
    });

    it("logs KNOWLEDGE_SHARE event", async () => {
      const ctx = createToolContext(db, "0xSecurity", "security-compliance");

      await getTool("team_share_knowledge").execute(
        {
          category: "security",
          title: "Path traversal in tool args",
          content_json: JSON.stringify({ finding: "common in MCP servers" }),
        },
        ctx,
      );

      const events = db.raw
        .prepare(
          "SELECT * FROM team_events WHERE event_type = 'KNOWLEDGE_SHARE'",
        )
        .all() as Array<Record<string, unknown>>;
      expect(events.length).toBe(1);
    });
  });

  describe("team_query_knowledge", () => {
    beforeEach(async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      // Seed knowledge entries
      await getTool("team_share_knowledge").execute(
        {
          category: "technical",
          title: "MCP transport requires SSE for streaming",
          content_json: JSON.stringify({ detail: "Use SSE for long operations" }),
          confidence: 0.8,
        },
        ctx,
      );

      await getTool("team_share_knowledge").execute(
        {
          category: "market",
          title: "Enterprise agents prefer monthly billing",
          content_json: JSON.stringify({ detail: "x402 per-call is fine for dev" }),
          confidence: 0.6,
        },
        ctx,
      );

      await getTool("team_share_knowledge").execute(
        {
          category: "technical",
          title: "x402 payment verification adds 50ms latency",
          content_json: JSON.stringify({ detail: "Acceptable for most use cases" }),
          confidence: 0.95,
        },
        ctx,
      );
    });

    it("filters by category", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_query_knowledge").execute(
        { category: "technical" },
        ctx,
      );
      const entries = JSON.parse(result);
      expect(entries.length).toBe(2);
      expect(entries.every((e: { category: string }) => e.category === "technical")).toBe(true);
    });

    it("filters by keyword", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_query_knowledge").execute(
        { keyword: "x402" },
        ctx,
      );
      const entries = JSON.parse(result);
      expect(entries.length).toBe(2);
    });

    it("filters by minimum confidence", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_query_knowledge").execute(
        { min_confidence: 0.9 },
        ctx,
      );
      const entries = JSON.parse(result);
      expect(entries.length).toBe(1);
      expect(entries[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("increments use_count on query", async () => {
      const ctx = createToolContext(db);

      // Query once
      await getTool("team_query_knowledge").execute({ category: "technical" }, ctx);

      // Check use_count was incremented
      const entries = db.raw
        .prepare("SELECT use_count FROM team_knowledge WHERE category = 'technical'")
        .all() as Array<{ use_count: number }>;
      expect(entries.every((e) => e.use_count >= 1)).toBe(true);
    });

    it("returns empty message when no matches", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_query_knowledge").execute(
        { category: "nonexistent" },
        ctx,
      );
      expect(result).toContain("No knowledge entries found");
    });
  });

  describe("team_rate_outcome", () => {
    it("updates task outcome columns", async () => {
      const ctx = createToolContext(db, "0xOrchestrator", "orchestrator");

      // Create and complete a task
      await getTool("team_create_task").execute(
        { title: "Ship scanner v1" },
        ctx,
      );
      const tasks = JSON.parse(
        await getTool("team_list_tasks").execute({ status: "NEW" }, ctx),
      );
      const taskId = tasks[0].task_id;

      // Rate outcome
      const result = await getTool("team_rate_outcome").execute(
        {
          task_id: taskId,
          score: 4,
          notes: "Shipped on time, minor issues with CORS",
          revenue_generated_cents: 500,
          iterations_required: 2,
        },
        ctx,
      );

      expect(result).toContain("Outcome rated:");
      expect(result).toContain("4/5");
      expect(result).toContain("$5.00");

      // Verify in database
      const task = db.raw
        .prepare("SELECT * FROM team_tasks WHERE task_id = ?")
        .get(taskId) as Record<string, unknown>;
      expect(task.outcome_score).toBe(4);
      expect(task.outcome_notes).toBe("Shipped on time, minor issues with CORS");
      expect(task.revenue_generated_cents).toBe(500);
      expect(task.iterations_required).toBe(2);
    });

    it("rejects invalid score", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_rate_outcome").execute(
        { task_id: "some-task", score: 6 },
        ctx,
      );
      expect(result).toContain("Error");
      expect(result).toContain("between 1 and 5");
    });

    it("returns error for non-existent task", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_rate_outcome").execute(
        { task_id: "non-existent", score: 3 },
        ctx,
      );
      expect(result).toContain("Error");
      expect(result).toContain("not found");
    });

    it("logs OUTCOME_RATED event", async () => {
      const ctx = createToolContext(db, "0xOrchestrator", "orchestrator");
      await getTool("team_create_task").execute({ title: "Test" }, ctx);
      const tasks = JSON.parse(
        await getTool("team_list_tasks").execute({ status: "NEW" }, ctx),
      );

      await getTool("team_rate_outcome").execute(
        { task_id: tasks[0].task_id, score: 5 },
        ctx,
      );

      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'OUTCOME_RATED'")
        .all() as Array<Record<string, unknown>>;
      expect(events.length).toBe(1);
    });
  });

  describe("team_get_learnings", () => {
    it("retrieves retrospectives for a specific task", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      // Create task and retrospective
      await getTool("team_create_task").execute({ title: "Build feature" }, ctx);
      const tasks = JSON.parse(
        await getTool("team_list_tasks").execute({ status: "NEW" }, ctx),
      );
      const taskId = tasks[0].task_id;

      await getTool("team_submit_retrospective").execute(
        {
          task_id: taskId,
          lessons: JSON.stringify(["Always test edge cases"]),
        },
        ctx,
      );

      // Retrieve learnings for task
      const result = await getTool("team_get_learnings").execute(
        { task_id: taskId },
        ctx,
      );
      const learnings = JSON.parse(result);
      expect(learnings.retrospectives.length).toBe(1);
    });

    it("retrieves knowledge entries by role", async () => {
      const ctx = createToolContext(db, "0xSecurity", "security-compliance");

      await getTool("team_share_knowledge").execute(
        {
          category: "security",
          title: "Common MCP vulnerability",
          content_json: JSON.stringify({ finding: "path traversal" }),
          confidence: 0.85,
        },
        ctx,
      );

      const result = await getTool("team_get_learnings").execute(
        { role: "security-compliance" },
        ctx,
      );
      const learnings = JSON.parse(result);
      expect(learnings.knowledge.length).toBe(1);
      expect(learnings.knowledge[0].title).toBe("Common MCP vulnerability");
    });

    it("returns all recent learnings when no filter", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      // Create some data
      await getTool("team_create_task").execute({ title: "Task A" }, ctx);
      const tasks = JSON.parse(
        await getTool("team_list_tasks").execute({ status: "NEW" }, ctx),
      );
      await getTool("team_submit_retrospective").execute(
        { task_id: tasks[0].task_id },
        ctx,
      );
      await getTool("team_share_knowledge").execute(
        {
          category: "technical",
          title: "Useful pattern",
          content_json: JSON.stringify({ info: "test" }),
        },
        ctx,
      );

      const result = await getTool("team_get_learnings").execute({}, ctx);
      const learnings = JSON.parse(result);
      expect(learnings.retrospectives.length).toBeGreaterThan(0);
      expect(learnings.knowledge.length).toBeGreaterThan(0);
    });

    it("returns empty message when no learnings exist", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("team_get_learnings").execute(
        { role: "nonexistent-role" },
        ctx,
      );
      expect(result).toContain("No learnings found");
    });
  });

  describe("tool discovery", () => {
    it("registers all 15 team tools", () => {
      expect(tools.length).toBe(15);
    });

    it("new learning tools have correct categories", () => {
      const learningTools = [
        "team_submit_retrospective",
        "team_share_knowledge",
        "team_query_knowledge",
        "team_rate_outcome",
        "team_get_learnings",
      ];
      for (const name of learningTools) {
        const tool = getTool(name);
        expect(tool.category).toBe("memory");
        expect(tool.riskLevel).toBe("safe");
      }
    });
  });
});
