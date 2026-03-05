/**
 * Publish Tools Tests
 *
 * Tests the approval gate flow and API interactions for
 * publish_x, publish_threads, and publish_linkedin tools.
 * Uses vi.stubGlobal to mock fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTestDb,
  createTestIdentity,
  createTestConfig,
  MockConwayClient,
  MockInferenceClient,
} from "../mocks.js";
import type { AutomatonDatabase, ToolContext } from "../../types.js";
import { createPublishTools } from "../../team/publish-tools.js";

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

describe("publish tools", () => {
  let db: AutomatonDatabase;
  let tools: ReturnType<typeof createPublishTools>;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    db = createTestDb();
    tools = createPublishTools();
    // Set team.role so event logging works
    db.setKV("team.role", "chronicler");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    // Restore fetch
    globalThis.fetch = originalFetch;
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  function getTool(name: string) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    return tool;
  }

  // ─── Shared approval gate tests ──────────────────────────────

  describe("approval gate", () => {
    it("creates PENDING approval when no approval_id provided", async () => {
      const ctx = createToolContext(db);
      const result = await getTool("publish_x").execute(
        { content: "Hello world" },
        ctx,
      );

      expect(result).toContain("Approval requested:");
      expect(result).toContain("awaiting human approval");
    });

    it("returns 'awaiting' for PENDING approval", async () => {
      const ctx = createToolContext(db);

      // Create an approval
      const result1 = await getTool("publish_x").execute(
        { content: "Hello world" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1];
      expect(approvalId).toBeDefined();

      // Check it — should still be pending
      const result2 = await getTool("publish_x").execute(
        { content: "Hello world", approval_id: approvalId },
        ctx,
      );
      expect(result2).toContain("still awaiting human review");
    });

    it("returns denial reason for DENIED approval", async () => {
      const ctx = createToolContext(db);

      // Create and deny an approval
      const result1 = await getTool("publish_x").execute(
        { content: "Hello world" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;

      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'DENIED', human_notes = 'Not appropriate' WHERE approval_id = ?`,
        )
        .run(approvalId);

      const result2 = await getTool("publish_x").execute(
        { content: "Hello world", approval_id: approvalId },
        ctx,
      );
      expect(result2).toContain("denied");
      expect(result2).toContain("Not appropriate");
    });
  });

  // ─── publish_x ──────────────────────────────────────────────

  describe("publish_x", () => {
    it("returns error when X_ACCESS_TOKEN is missing", async () => {
      const ctx = createToolContext(db);

      // Create and approve
      const result1 = await getTool("publish_x").execute(
        { content: "Hello X" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;
      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'APPROVED' WHERE approval_id = ?`,
        )
        .run(approvalId);

      // Ensure no token
      delete process.env.X_ACCESS_TOKEN;

      await expect(
        getTool("publish_x").execute(
          { content: "Hello X", approval_id: approvalId },
          ctx,
        ),
      ).rejects.toThrow("Missing X_ACCESS_TOKEN");
    });

    it("publishes a single tweet on APPROVED", async () => {
      const ctx = createToolContext(db);

      // Create and approve
      const result1 = await getTool("publish_x").execute(
        { content: "Hello X" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;
      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'APPROVED' WHERE approval_id = ?`,
        )
        .run(approvalId);

      // Set token
      process.env.X_ACCESS_TOKEN = "test-access-token";
      process.env.X_TOKEN_EXPIRES_AT = new Date(
        Date.now() + 3600_000,
      ).toISOString();

      // Mock fetch
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ data: { id: "tweet123", text: "Hello X" } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result2 = await getTool("publish_x").execute(
        { content: "Hello X", approval_id: approvalId },
        ctx,
      );

      expect(result2).toContain("Published tweet");
      expect(result2).toContain("tweet123");

      // Verify fetch was called correctly
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.x.com/2/tweets",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-access-token",
          }),
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Hello X");
    });

    it("publishes a thread with reply chaining", async () => {
      const ctx = createToolContext(db);

      // Create and approve
      const result1 = await getTool("publish_x").execute(
        {
          content: JSON.stringify(["Tweet 1", "Tweet 2", "Tweet 3"]),
        },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;
      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'APPROVED' WHERE approval_id = ?`,
        )
        .run(approvalId);

      process.env.X_ACCESS_TOKEN = "test-access-token";
      process.env.X_TOKEN_EXPIRES_AT = new Date(
        Date.now() + 3600_000,
      ).toISOString();

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { id: `tweet_${callCount}`, text: `Tweet ${callCount}` },
            }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result2 = await getTool("publish_x").execute(
        {
          content: JSON.stringify(["Tweet 1", "Tweet 2", "Tweet 3"]),
          approval_id: approvalId,
        },
        ctx,
      );

      expect(result2).toContain("Published thread (3 tweets)");
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // First tweet: no reply
      const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body1.text).toBe("Tweet 1");
      expect(body1.reply).toBeUndefined();

      // Second tweet: replies to first
      const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body2.text).toBe("Tweet 2");
      expect(body2.reply.in_reply_to_tweet_id).toBe("tweet_1");

      // Third tweet: replies to second
      const body3 = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(body3.text).toBe("Tweet 3");
      expect(body3.reply.in_reply_to_tweet_id).toBe("tweet_2");
    });

    it("logs PUBLISH event to team_events on success", async () => {
      const ctx = createToolContext(db);

      const result1 = await getTool("publish_x").execute(
        { content: "Log test" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;
      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'APPROVED' WHERE approval_id = ?`,
        )
        .run(approvalId);

      process.env.X_ACCESS_TOKEN = "test-access-token";
      process.env.X_TOKEN_EXPIRES_AT = new Date(
        Date.now() + 3600_000,
      ).toISOString();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({ data: { id: "tweet_log", text: "Log test" } }),
        }),
      );

      await getTool("publish_x").execute(
        { content: "Log test", approval_id: approvalId },
        ctx,
      );

      const events = db.raw
        .prepare(
          "SELECT * FROM team_events WHERE event_type = 'PUBLISH'",
        )
        .all() as Array<{ payload_json: string; agent_role: string }>;

      expect(events.length).toBe(1);
      expect(events[0].agent_role).toBe("chronicler");
      const payload = JSON.parse(events[0].payload_json);
      expect(payload.platform).toBe("X");
    });
  });

  // ─── publish_threads ────────────────────────────────────────

  describe("publish_threads", () => {
    it("rejects content over 500 chars", async () => {
      const ctx = createToolContext(db);
      const longContent = "a".repeat(501);
      const result = await getTool("publish_threads").execute(
        { content: longContent },
        ctx,
      );
      expect(result).toContain("Content too long");
      expect(result).toContain("501");
    });

    it("publishes via two-step flow on APPROVED", async () => {
      const ctx = createToolContext(db);

      const result1 = await getTool("publish_threads").execute(
        { content: "Hello Threads" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;
      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'APPROVED' WHERE approval_id = ?`,
        )
        .run(approvalId);

      process.env.THREADS_ACCESS_TOKEN = "threads-token";
      process.env.THREADS_USER_ID = "12345";
      process.env.THREADS_TOKEN_EXPIRES_AT = new Date(
        Date.now() + 3600_000,
      ).toISOString();

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          // Create container
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "container_123" }),
          });
        }
        // Publish
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "post_456" }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result2 = await getTool("publish_threads").execute(
        { content: "Hello Threads", approval_id: approvalId },
        ctx,
      );

      expect(result2).toContain("Published to Threads");
      expect(result2).toContain("post_456");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Verify create call
      expect(fetchMock.mock.calls[0][0]).toContain("/12345/threads");
      // Verify publish call
      expect(fetchMock.mock.calls[1][0]).toContain("/12345/threads_publish");
    });
  });

  // ─── publish_linkedin ───────────────────────────────────────

  describe("publish_linkedin", () => {
    it("publishes with correct headers on APPROVED", async () => {
      const ctx = createToolContext(db);

      const result1 = await getTool("publish_linkedin").execute(
        { content: "Hello LinkedIn" },
        ctx,
      );
      const approvalId = result1.match(/Approval requested: (\S+)/)?.[1]!;
      db.raw
        .prepare(
          `UPDATE team_approvals SET status = 'APPROVED' WHERE approval_id = ?`,
        )
        .run(approvalId);

      process.env.LINKEDIN_ACCESS_TOKEN = "linkedin-token";
      process.env.LINKEDIN_PERSON_URN = "abc123";
      process.env.LINKEDIN_TOKEN_EXPIRES_AT = new Date(
        Date.now() + 3600_000,
      ).toISOString();

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        headers: new Map([["x-restli-id", "post_789"]]),
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result2 = await getTool("publish_linkedin").execute(
        { content: "Hello LinkedIn", approval_id: approvalId },
        ctx,
      );

      expect(result2).toContain("Published to LinkedIn");

      // Verify headers
      const callHeaders = fetchMock.mock.calls[0][1].headers;
      expect(callHeaders.Authorization).toBe("Bearer linkedin-token");
      expect(callHeaders["X-Restli-Protocol-Version"]).toBe("2.0.0");
      expect(callHeaders["LinkedIn-Version"]).toBe("202401");

      // Verify body
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.author).toBe("urn:li:person:abc123");
      expect(body.lifecycleState).toBe("PUBLISHED");
      expect(body.visibility).toBe("PUBLIC");
      expect(body.commentary).toBe("Hello LinkedIn");
    });
  });
});
