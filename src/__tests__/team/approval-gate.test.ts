/**
 * Approval Gate Tests
 *
 * Full lifecycle: request → PENDING → APPROVED/DENIED.
 * Error cases: not found, already resolved, invalid IDs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../mocks.js";
import type { AutomatonDatabase } from "../../types.js";
import {
  requestApproval,
  checkApproval,
  resolveApproval,
  getPendingApprovals,
} from "../../team/approval-gate.js";

describe("team approval gate", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("creates a PENDING approval and returns an ID", async () => {
    const approvalId = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "deploy",
      actionDescription: "Deploy v1 to production",
      actionPayload: { target: "prod" },
      riskAssessment: "HIGH",
    });

    expect(approvalId).toBeTruthy();
    expect(typeof approvalId).toBe("string");

    const result = await checkApproval(db.raw, approvalId);
    expect(result.status).toBe("PENDING");
    expect(result.humanNotes).toBeNull();
  });

  it("resolves an approval as APPROVED", async () => {
    const approvalId = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "transfer",
      actionDescription: "Transfer 500 credits",
    });

    await resolveApproval(db.raw, approvalId, "APPROVED", "investor", "Looks good");

    const result = await checkApproval(db.raw, approvalId);
    expect(result.status).toBe("APPROVED");
    expect(result.humanNotes).toBe("Looks good");
  });

  it("resolves an approval as DENIED", async () => {
    const approvalId = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "publish",
      actionDescription: "Publish MCP server to registry",
    });

    await resolveApproval(db.raw, approvalId, "DENIED", "investor", "Not ready yet");

    const result = await checkApproval(db.raw, approvalId);
    expect(result.status).toBe("DENIED");
    expect(result.humanNotes).toBe("Not ready yet");
  });

  it("rejects resolving an already-resolved approval", async () => {
    const approvalId = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "deploy",
    });

    await resolveApproval(db.raw, approvalId, "APPROVED", "investor");

    await expect(
      resolveApproval(db.raw, approvalId, "DENIED", "investor"),
    ).rejects.toThrow("not found or already resolved");
  });

  it("rejects resolving a non-existent approval", async () => {
    await expect(
      resolveApproval(db.raw, "non-existent-id", "APPROVED", "investor"),
    ).rejects.toThrow("not found or already resolved");
  });

  it("returns NOT_FOUND for unknown approval ID", async () => {
    const result = await checkApproval(db.raw, "does-not-exist");
    expect(result.status).toBe("NOT_FOUND");
    expect(result.humanNotes).toBeNull();
  });

  it("lists only PENDING approvals", async () => {
    const id1 = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "deploy",
    });
    const id2 = await requestApproval(db.raw, {
      requestedBy: "0xAgent2",
      actionType: "transfer",
    });
    const id3 = await requestApproval(db.raw, {
      requestedBy: "0xAgent3",
      actionType: "publish",
    });

    // Resolve one
    await resolveApproval(db.raw, id2, "APPROVED", "investor");

    const pending = await getPendingApprovals(db.raw);
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.approvalId)).toContain(id1);
    expect(pending.map((p) => p.approvalId)).toContain(id3);
    expect(pending.map((p) => p.approvalId)).not.toContain(id2);
  });

  it("stores action payload as JSON", async () => {
    const payload = { amount: 500, target: "prod", reason: "customer request" };
    const approvalId = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "transfer",
      actionPayload: payload,
    });

    const pending = await getPendingApprovals(db.raw);
    const approval = pending.find((p) => p.approvalId === approvalId);
    expect(approval).toBeTruthy();
    expect(JSON.parse(approval!.actionPayloadJson)).toEqual(payload);
  });

  it("handles approval without optional fields", async () => {
    const approvalId = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "deploy",
    });

    const pending = await getPendingApprovals(db.raw);
    const approval = pending.find((p) => p.approvalId === approvalId);
    expect(approval).toBeTruthy();
    expect(approval!.actionDescription).toBeNull();
    expect(approval!.riskAssessment).toBeNull();
    expect(JSON.parse(approval!.actionPayloadJson)).toEqual({});
  });

  it("returns approvals in chronological order", async () => {
    const id1 = await requestApproval(db.raw, {
      requestedBy: "0xAgent1",
      actionType: "first",
    });
    const id2 = await requestApproval(db.raw, {
      requestedBy: "0xAgent2",
      actionType: "second",
    });

    const pending = await getPendingApprovals(db.raw);
    expect(pending[0].approvalId).toBe(id1);
    expect(pending[1].approvalId).toBe(id2);
  });
});
