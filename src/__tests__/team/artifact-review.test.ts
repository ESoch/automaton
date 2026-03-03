/**
 * Artifact Review Tests
 *
 * State machine: DRAFT → IN_REVIEW → APPROVED.
 * Rejection: IN_REVIEW → DRAFT. Error cases for invalid transitions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../mocks.js";
import type { AutomatonDatabase } from "../../types.js";
import {
  submitForReview,
  approveArtifact,
  rejectArtifact,
  getArtifact,
  getArtifactsByStatus,
} from "../../team/artifact-review.js";
import { createHash } from "crypto";
import { ulid } from "ulid";

function insertDraftArtifact(
  db: AutomatonDatabase,
  overrides: {
    artifactId?: string;
    artifactType?: string;
    createdBy?: string;
    content?: Record<string, unknown>;
  } = {},
) {
  const artifactId = overrides.artifactId ?? ulid();
  const contentJson = JSON.stringify(overrides.content ?? { title: "Test artifact" });
  const hash = createHash("sha256").update(contentJson).digest("hex");

  db.raw
    .prepare(
      `INSERT INTO team_artifacts (artifact_id, artifact_type, created_by, content_json, hash, review_status)
       VALUES (?, ?, ?, ?, ?, 'DRAFT')`,
    )
    .run(
      artifactId,
      overrides.artifactType ?? "design_doc",
      overrides.createdBy ?? "0xAgent1",
      contentJson,
      hash,
    );

  return artifactId;
}

describe("team artifact review", () => {
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

  it("submits a DRAFT artifact for review", async () => {
    const artifactId = insertDraftArtifact(db);

    await submitForReview(db.raw, artifactId);

    const artifact = await getArtifact(db.raw, artifactId);
    expect(artifact).not.toBeNull();
    expect(artifact!.reviewStatus).toBe("IN_REVIEW");
  });

  it("approves an IN_REVIEW artifact", async () => {
    const artifactId = insertDraftArtifact(db);
    await submitForReview(db.raw, artifactId);

    await approveArtifact(db.raw, artifactId, "0xReviewer");

    const artifact = await getArtifact(db.raw, artifactId);
    expect(artifact!.reviewStatus).toBe("APPROVED");
    const approvedBy = JSON.parse(artifact!.approvedByJson);
    expect(approvedBy).toContain("0xReviewer");
  });

  it("rejects an IN_REVIEW artifact back to DRAFT", async () => {
    const artifactId = insertDraftArtifact(db);
    await submitForReview(db.raw, artifactId);

    await rejectArtifact(db.raw, artifactId, "Needs more detail");

    const artifact = await getArtifact(db.raw, artifactId);
    expect(artifact!.reviewStatus).toBe("DRAFT");
  });

  it("rejected artifact can be re-submitted for review", async () => {
    const artifactId = insertDraftArtifact(db);
    await submitForReview(db.raw, artifactId);
    await rejectArtifact(db.raw, artifactId, "Needs work");

    // Re-submit
    await submitForReview(db.raw, artifactId);
    const artifact = await getArtifact(db.raw, artifactId);
    expect(artifact!.reviewStatus).toBe("IN_REVIEW");
  });

  it("cannot submit a non-existent artifact for review", async () => {
    await expect(submitForReview(db.raw, "nonexistent")).rejects.toThrow(
      "not found or not in DRAFT status",
    );
  });

  it("cannot approve a DRAFT artifact directly", async () => {
    const artifactId = insertDraftArtifact(db);

    await expect(approveArtifact(db.raw, artifactId, "0xReviewer")).rejects.toThrow(
      "not found or not in IN_REVIEW status",
    );
  });

  it("cannot reject a DRAFT artifact", async () => {
    const artifactId = insertDraftArtifact(db);

    await expect(rejectArtifact(db.raw, artifactId, "reason")).rejects.toThrow(
      "not found or not in IN_REVIEW status",
    );
  });

  it("cannot submit an already IN_REVIEW artifact", async () => {
    const artifactId = insertDraftArtifact(db);
    await submitForReview(db.raw, artifactId);

    await expect(submitForReview(db.raw, artifactId)).rejects.toThrow(
      "not found or not in DRAFT status",
    );
  });

  it("records multiple approvers in approved_by_json", async () => {
    const artifactId = insertDraftArtifact(db);
    await submitForReview(db.raw, artifactId);

    await approveArtifact(db.raw, artifactId, "0xReviewer1");

    // Force back to IN_REVIEW to test multiple approvals
    db.raw
      .prepare("UPDATE team_artifacts SET review_status = 'IN_REVIEW' WHERE artifact_id = ?")
      .run(artifactId);

    await approveArtifact(db.raw, artifactId, "0xReviewer2");

    const artifact = await getArtifact(db.raw, artifactId);
    const approvedBy = JSON.parse(artifact!.approvedByJson);
    expect(approvedBy).toContain("0xReviewer1");
    expect(approvedBy).toContain("0xReviewer2");
  });

  it("does not duplicate approvers", async () => {
    const artifactId = insertDraftArtifact(db);
    await submitForReview(db.raw, artifactId);

    await approveArtifact(db.raw, artifactId, "0xReviewer1");

    // Force back to IN_REVIEW
    db.raw
      .prepare("UPDATE team_artifacts SET review_status = 'IN_REVIEW' WHERE artifact_id = ?")
      .run(artifactId);

    await approveArtifact(db.raw, artifactId, "0xReviewer1");

    const artifact = await getArtifact(db.raw, artifactId);
    const approvedBy = JSON.parse(artifact!.approvedByJson);
    expect(approvedBy.filter((a: string) => a === "0xReviewer1").length).toBe(1);
  });

  it("returns null for non-existent artifact", async () => {
    const artifact = await getArtifact(db.raw, "does-not-exist");
    expect(artifact).toBeNull();
  });

  it("filters artifacts by review status", async () => {
    const draft1 = insertDraftArtifact(db, { artifactType: "report" });
    const draft2 = insertDraftArtifact(db, { artifactType: "code" });
    const reviewId = insertDraftArtifact(db, { artifactType: "eval" });
    await submitForReview(db.raw, reviewId);

    const drafts = await getArtifactsByStatus(db.raw, "DRAFT");
    expect(drafts.length).toBe(2);

    const inReview = await getArtifactsByStatus(db.raw, "IN_REVIEW");
    expect(inReview.length).toBe(1);
    expect(inReview[0].artifactId).toBe(reviewId);
  });

  it("preserves content hash on storage", async () => {
    const content = { title: "Design Doc", version: "1.0" };
    const contentJson = JSON.stringify(content);
    const expectedHash = createHash("sha256").update(contentJson).digest("hex");

    const artifactId = insertDraftArtifact(db, { content });

    const artifact = await getArtifact(db.raw, artifactId);
    expect(artifact!.hash).toBe(expectedHash);
  });
});
