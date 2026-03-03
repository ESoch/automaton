/**
 * Task Lifecycle Tests
 *
 * Full flow: create → claim → complete with artifact.
 * Validates status transitions, assignment, and task queries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient } from "../mocks.js";
import type { AutomatonDatabase, ToolContext } from "../../types.js";
import { createTeamTools } from "../../team/team-tools.js";

function createToolContext(
  db: AutomatonDatabase,
  addressOverride?: string,
): ToolContext {
  const identity = createTestIdentity();
  if (addressOverride) {
    identity.address = addressOverride as `0x${string}`;
  }
  return {
    identity,
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
}

describe("team task lifecycle", () => {
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

  it("creates a task in NEW status", async () => {
    const ctx = createToolContext(db);
    const result = await getTool("team_create_task").execute(
      { title: "Build MCP server", description: "Create a data utility MCP server" },
      ctx,
    );

    expect(result).toContain("Task created:");
    expect(result).toContain("Build MCP server");

    // Verify in database
    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const tasks = JSON.parse(listResult);
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("Build MCP server");
    expect(tasks[0].status).toBe("NEW");
  });

  it("claims a NEW task", async () => {
    const ctx = createToolContext(db, "0xOrchestrator");
    await getTool("team_create_task").execute({ title: "Research market gap" }, ctx);

    // Get task ID from list
    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const tasks = JSON.parse(listResult);
    const taskId = tasks[0].task_id;

    // Claim with a different agent
    const claimCtx = createToolContext(db, "0xResearcher");
    const claimResult = await getTool("team_claim_task").execute({ task_id: taskId }, claimCtx);

    expect(claimResult).toContain("claimed by");
    expect(claimResult).toContain("0xResearcher");
    expect(claimResult).toContain("Lease expires:");
  });

  it("prevents claiming a non-NEW task", async () => {
    const ctx = createToolContext(db);
    await getTool("team_create_task").execute({ title: "Task" }, ctx);

    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const tasks = JSON.parse(listResult);
    const taskId = tasks[0].task_id;

    // Claim once
    await getTool("team_claim_task").execute({ task_id: taskId }, ctx);

    // Try to claim again
    const secondClaim = await getTool("team_claim_task").execute({ task_id: taskId }, ctx);
    expect(secondClaim).toContain("Failed to claim");
  });

  it("completes a claimed task", async () => {
    const ctx = createToolContext(db, "0xBuilder");
    await getTool("team_create_task").execute({ title: "Implement feature" }, ctx);

    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const taskId = JSON.parse(listResult)[0].task_id;

    await getTool("team_claim_task").execute({ task_id: taskId }, ctx);

    const completeResult = await getTool("team_complete_task").execute(
      { task_id: taskId },
      ctx,
    );
    expect(completeResult).toContain("completed");

    // Verify status is DONE
    const doneList = await getTool("team_list_tasks").execute({ status: "DONE" }, ctx);
    const doneTasks = JSON.parse(doneList);
    expect(doneTasks.length).toBe(1);
    expect(doneTasks[0].task_id).toBe(taskId);
  });

  it("completes a task with an artifact ID", async () => {
    const ctx = createToolContext(db, "0xBuilder");
    await getTool("team_create_task").execute({ title: "Write report" }, ctx);

    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const taskId = JSON.parse(listResult)[0].task_id;
    await getTool("team_claim_task").execute({ task_id: taskId }, ctx);

    const completeResult = await getTool("team_complete_task").execute(
      { task_id: taskId, artifact_id: "artifact-123" },
      ctx,
    );
    expect(completeResult).toContain("Artifact: artifact-123");

    // Verify artifact_id is set
    const row = db.raw
      .prepare("SELECT artifact_id FROM team_tasks WHERE task_id = ?")
      .get(taskId) as { artifact_id: string };
    expect(row.artifact_id).toBe("artifact-123");
  });

  it("prevents completing a task not assigned to you", async () => {
    const orchestratorCtx = createToolContext(db, "0xOrchestrator");
    const builderCtx = createToolContext(db, "0xBuilder");

    await getTool("team_create_task").execute({ title: "Build thing" }, orchestratorCtx);

    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, orchestratorCtx);
    const taskId = JSON.parse(listResult)[0].task_id;

    // Orchestrator claims
    await getTool("team_claim_task").execute({ task_id: taskId }, orchestratorCtx);

    // Builder tries to complete
    const result = await getTool("team_complete_task").execute(
      { task_id: taskId },
      builderCtx,
    );
    expect(result).toContain("Failed to complete");
  });

  it("supports task priority ordering", async () => {
    const ctx = createToolContext(db);

    await getTool("team_create_task").execute(
      { title: "Low priority", priority: 200 },
      ctx,
    );
    await getTool("team_create_task").execute(
      { title: "High priority", priority: 10 },
      ctx,
    );
    await getTool("team_create_task").execute(
      { title: "Medium priority", priority: 100 },
      ctx,
    );

    const listResult = await getTool("team_list_tasks").execute({}, ctx);
    const tasks = JSON.parse(listResult);

    expect(tasks[0].title).toBe("High priority");
    expect(tasks[1].title).toBe("Medium priority");
    expect(tasks[2].title).toBe("Low priority");
  });

  it("handles direct assignment via assign_to", async () => {
    const ctx = createToolContext(db);
    await getTool("team_create_task").execute(
      { title: "Assigned task", assign_to: "0xResearcher" },
      ctx,
    );

    const listResult = await getTool("team_list_tasks").execute({}, ctx);
    const tasks = JSON.parse(listResult);
    expect(tasks[0].assigned_to).toBe("0xResearcher");
  });

  it("returns empty message when no tasks exist", async () => {
    const ctx = createToolContext(db);
    const result = await getTool("team_list_tasks").execute({}, ctx);
    expect(result).toContain("No tasks");
  });

  it("increments attempt_count on each claim", async () => {
    const ctx = createToolContext(db);
    await getTool("team_create_task").execute({ title: "Retry task" }, ctx);

    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const taskId = JSON.parse(listResult)[0].task_id;

    // First claim
    await getTool("team_claim_task").execute({ task_id: taskId }, ctx);

    // Reset to NEW for re-claim
    db.raw.prepare("UPDATE team_tasks SET status = 'NEW' WHERE task_id = ?").run(taskId);

    // Second claim
    await getTool("team_claim_task").execute({ task_id: taskId }, ctx);

    const row = db.raw
      .prepare("SELECT attempt_count FROM team_tasks WHERE task_id = ?")
      .get(taskId) as { attempt_count: number };
    expect(row.attempt_count).toBe(2);
  });

  it("stores payload JSON on task creation", async () => {
    const ctx = createToolContext(db);
    const payload = JSON.stringify({ target: "mcp-registry", version: "1.0" });

    await getTool("team_create_task").execute(
      { title: "Publish", payload },
      ctx,
    );

    const listResult = await getTool("team_list_tasks").execute({ status: "NEW" }, ctx);
    const tasks = JSON.parse(listResult);
    expect(JSON.parse(tasks[0].payload_json)).toEqual({
      target: "mcp-registry",
      version: "1.0",
    });
  });
});
