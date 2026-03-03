/**
 * Communication Tests
 *
 * Validates inter-agent communication: direct messages, status broadcasts,
 * event logging, and team event queries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient } from "../mocks.js";
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
  // Set role in KV store
  if (role) {
    db.setKV("team.role", role);
  }
  return {
    identity,
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
}

describe("team communication", () => {
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

  describe("team_broadcast_status", () => {
    it("broadcasts status to team event log", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");

      const result = await getTool("team_broadcast_status").execute(
        {
          current_task: "Implementing MCP server",
          progress_percent: 60,
          blockers: null,
          last_artifact: "artifact-123",
        },
        ctx,
      );

      expect(result).toContain("Status broadcast:");
      expect(result).toContain("Implementing MCP server");
      expect(result).toContain("60%");

      // Verify in database
      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'STATUS_BROADCAST'")
        .all() as Array<{
          event_id: string;
          agent_id: string;
          agent_role: string;
          payload_json: string;
        }>;

      expect(events.length).toBe(1);
      expect(events[0].agent_id).toBe("0xBuilder");
      expect(events[0].agent_role).toBe("builder-engineer");

      const payload = JSON.parse(events[0].payload_json);
      expect(payload.currentTask).toBe("Implementing MCP server");
      expect(payload.progressPercent).toBe(60);
      expect(payload.lastArtifact).toBe("artifact-123");
    });

    it("reads agent role from KV store", async () => {
      const ctx = createToolContext(db, "0xResearcher", "research-pm");

      await getTool("team_broadcast_status").execute(
        { current_task: "Scanning registries" },
        ctx,
      );

      const events = db.raw
        .prepare("SELECT agent_role FROM team_events WHERE event_type = 'STATUS_BROADCAST'")
        .all() as Array<{ agent_role: string }>;

      expect(events[0].agent_role).toBe("research-pm");
    });

    it("defaults to 'unknown' role when KV not set", async () => {
      const identity = createTestIdentity();
      identity.address = "0xNoRole" as `0x${string}`;
      const ctx: ToolContext = {
        identity,
        config: createTestConfig(),
        db,
        conway: new MockConwayClient(),
        inference: new MockInferenceClient(),
      };

      await getTool("team_broadcast_status").execute(
        { current_task: "Working" },
        ctx,
      );

      const events = db.raw
        .prepare("SELECT agent_role FROM team_events WHERE event_type = 'STATUS_BROADCAST'")
        .all() as Array<{ agent_role: string }>;

      expect(events[0].agent_role).toBe("unknown");
    });
  });

  describe("team_direct_message", () => {
    it("sends a direct message to another agent", async () => {
      const ctx = createToolContext(db, "0xQA", "qa-evals");

      const result = await getTool("team_direct_message").execute(
        {
          target_agent_id: "0xBuilder",
          message_type: "review_request",
          content: "Test failures in auth module — 3 tests failing on edge cases",
        },
        ctx,
      );

      expect(result).toContain("Message sent to 0xBuilder");
      expect(result).toContain("[review_request]");

      // Verify in database
      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'DIRECT_MESSAGE'")
        .all() as Array<{
          agent_id: string;
          agent_role: string;
          target_agent_id: string;
          payload_json: string;
        }>;

      expect(events.length).toBe(1);
      expect(events[0].agent_id).toBe("0xQA");
      expect(events[0].agent_role).toBe("qa-evals");
      expect(events[0].target_agent_id).toBe("0xBuilder");

      const payload = JSON.parse(events[0].payload_json);
      expect(payload.messageType).toBe("review_request");
      expect(payload.content).toContain("Test failures");
    });

    it("supports all message types", async () => {
      const ctx = createToolContext(db, "0xBuilder", "builder-engineer");
      const messageTypes = ["question", "answer", "handoff", "review_request", "notification"];

      for (const mt of messageTypes) {
        await getTool("team_direct_message").execute(
          {
            target_agent_id: "0xOrchestrator",
            message_type: mt,
            content: `Test ${mt}`,
          },
          ctx,
        );
      }

      const events = db.raw
        .prepare("SELECT * FROM team_events WHERE event_type = 'DIRECT_MESSAGE'")
        .all() as Array<{ payload_json: string }>;

      expect(events.length).toBe(messageTypes.length);
      const types = events.map((e) => JSON.parse(e.payload_json).messageType);
      expect(types).toEqual(messageTypes);
    });

    it("truncates long messages in return value", async () => {
      const ctx = createToolContext(db, "0xAgent1");
      const longContent = "A".repeat(200);

      const result = await getTool("team_direct_message").execute(
        {
          target_agent_id: "0xAgent2",
          message_type: "notification",
          content: longContent,
        },
        ctx,
      );

      expect(result).toContain("...");

      // Full content is preserved in database
      const events = db.raw
        .prepare("SELECT payload_json FROM team_events WHERE event_type = 'DIRECT_MESSAGE'")
        .all() as Array<{ payload_json: string }>;

      const stored = JSON.parse(events[0].payload_json);
      expect(stored.content.length).toBe(200);
    });
  });

  describe("inter-agent coordination flow", () => {
    it("supports full handoff chain: Research → Orchestrator → Builder → QA", async () => {
      const researchCtx = createToolContext(db, "0xResearcher", "research-pm");
      const orchestratorCtx = createToolContext(db, "0xOrchestrator", "orchestrator");
      const builderCtx = createToolContext(db, "0xBuilder", "builder-engineer");
      const qaCtx = createToolContext(db, "0xQA", "qa-evals");

      // 1. Orchestrator creates task for Research
      await getTool("team_create_task").execute(
        { title: "Find market gap in data utilities", assign_to: "0xResearcher" },
        orchestratorCtx,
      );

      // 2. Research stores an Opportunity Brief artifact
      const storeResult = await getTool("team_store_artifact").execute(
        {
          artifact_type: "opportunity_brief",
          content_json: JSON.stringify({
            title: "Data Validation MCP Server",
            marketGap: "No agent-native data validation tools",
            willingnessToPay: "High — enterprises spending $50k+/yr on data quality",
            suggestedPricePoint: "$0.01/call",
          }),
        },
        researchCtx,
      );
      expect(storeResult).toContain("Artifact stored:");

      // 3. Research sends handoff message to Orchestrator
      await getTool("team_direct_message").execute(
        {
          target_agent_id: "0xOrchestrator",
          message_type: "handoff",
          content: "Opportunity Brief ready for review",
        },
        researchCtx,
      );

      // 4. Orchestrator creates task for Builder
      await getTool("team_create_task").execute(
        { title: "Build Data Validation MCP Server", assign_to: "0xBuilder", priority: 10 },
        orchestratorCtx,
      );

      // 5. Builder broadcasts status
      await getTool("team_broadcast_status").execute(
        { current_task: "Building Data Validation MCP Server", progress_percent: 30 },
        builderCtx,
      );

      // 6. QA sends test results directly to Builder
      await getTool("team_direct_message").execute(
        {
          target_agent_id: "0xBuilder",
          message_type: "notification",
          content: "Preliminary test results: 8/10 passing, 2 edge cases failing",
        },
        qaCtx,
      );

      // Verify all events are logged
      const allEvents = db.raw
        .prepare("SELECT * FROM team_events ORDER BY timestamp ASC")
        .all() as Array<{ event_type: string; agent_id: string; target_agent_id: string | null }>;

      expect(allEvents.length).toBe(3);
      // Status broadcast from Builder
      expect(allEvents.some((e) => e.event_type === "STATUS_BROADCAST" && e.agent_id === "0xBuilder")).toBe(true);
      // Direct messages are logged with target
      expect(allEvents.some((e) => e.event_type === "DIRECT_MESSAGE" && e.target_agent_id === "0xOrchestrator")).toBe(true);
      expect(allEvents.some((e) => e.event_type === "DIRECT_MESSAGE" && e.target_agent_id === "0xBuilder")).toBe(true);

      // Verify tasks created
      const allTasks = db.raw
        .prepare("SELECT * FROM team_tasks ORDER BY priority ASC")
        .all() as Array<{ title: string; assigned_to: string }>;
      expect(allTasks.length).toBe(2);
    });

    it("blocker escalation: agent sends blocker → appears in events", async () => {
      const builderCtx = createToolContext(db, "0xBuilder", "builder-engineer");

      // Builder sends a blocker to Orchestrator
      await getTool("team_direct_message").execute(
        {
          target_agent_id: "0xOrchestrator",
          message_type: "notification",
          content: "BLOCKER: Need API key for external data source before proceeding",
        },
        builderCtx,
      );

      // Verify the blocker is in events and visible to the Orchestrator
      const blockers = db.raw
        .prepare(
          "SELECT * FROM team_events WHERE event_type = 'DIRECT_MESSAGE' AND target_agent_id = '0xOrchestrator'",
        )
        .all() as Array<{ payload_json: string }>;

      expect(blockers.length).toBe(1);
      const payload = JSON.parse(blockers[0].payload_json);
      expect(payload.content).toContain("BLOCKER");
    });
  });
});
