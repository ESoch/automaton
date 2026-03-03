/**
 * Artifact Review
 *
 * State machine for artifact lifecycle: DRAFT -> IN_REVIEW -> APPROVED.
 * Rejected artifacts return to DRAFT with notes.
 */

import type Database from "better-sqlite3";

export interface Artifact {
  artifactId: string;
  artifactType: string;
  createdAt: string;
  createdBy: string;
  contentJson: string;
  hash: string;
  reviewStatus: string;
  approvedByJson: string;
}

/**
 * Submit a DRAFT artifact for review (DRAFT -> IN_REVIEW).
 */
export function submitForReview(
  db: Database.Database,
  artifactId: string,
): Promise<void> {
  const result = db
    .prepare(
      `UPDATE team_artifacts
       SET review_status = 'IN_REVIEW'
       WHERE artifact_id = ? AND review_status = 'DRAFT'`,
    )
    .run(artifactId);
  if (result.changes === 0) {
    return Promise.reject(
      new Error(
        `Artifact ${artifactId} not found or not in DRAFT status`,
      ),
    );
  }
  return Promise.resolve();
}

/**
 * Approve an IN_REVIEW artifact (IN_REVIEW -> APPROVED).
 * Records the approver in the approved_by_json list.
 */
export function approveArtifact(
  db: Database.Database,
  artifactId: string,
  approvedBy: string,
): Promise<void> {
  const row = db
    .prepare("SELECT approved_by_json FROM team_artifacts WHERE artifact_id = ? AND review_status = 'IN_REVIEW'")
    .get(artifactId) as { approved_by_json: string } | undefined;
  if (!row) {
    return Promise.reject(
      new Error(
        `Artifact ${artifactId} not found or not in IN_REVIEW status`,
      ),
    );
  }

  let approvedList: string[];
  try {
    approvedList = JSON.parse(row.approved_by_json) as string[];
  } catch {
    approvedList = [];
  }
  if (!approvedList.includes(approvedBy)) {
    approvedList.push(approvedBy);
  }

  db.prepare(
    `UPDATE team_artifacts
     SET review_status = 'APPROVED', approved_by_json = ?
     WHERE artifact_id = ?`,
  ).run(JSON.stringify(approvedList), artifactId);

  return Promise.resolve();
}

/**
 * Reject an IN_REVIEW artifact (IN_REVIEW -> DRAFT).
 * The reason is not stored on the artifact itself but can be logged via team_events.
 */
export function rejectArtifact(
  db: Database.Database,
  artifactId: string,
  _reason: string,
): Promise<void> {
  const result = db
    .prepare(
      `UPDATE team_artifacts
       SET review_status = 'DRAFT'
       WHERE artifact_id = ? AND review_status = 'IN_REVIEW'`,
    )
    .run(artifactId);
  if (result.changes === 0) {
    return Promise.reject(
      new Error(
        `Artifact ${artifactId} not found or not in IN_REVIEW status`,
      ),
    );
  }
  return Promise.resolve();
}

/**
 * Fetch a single artifact by ID.
 */
export function getArtifact(
  db: Database.Database,
  artifactId: string,
): Promise<Artifact | null> {
  const row = db
    .prepare("SELECT * FROM team_artifacts WHERE artifact_id = ?")
    .get(artifactId) as {
      artifact_id: string;
      artifact_type: string;
      created_at: string;
      created_by: string;
      content_json: string;
      hash: string;
      review_status: string;
      approved_by_json: string;
    } | undefined;
  if (!row) return Promise.resolve(null);
  return Promise.resolve(deserializeArtifact(row));
}

/**
 * List artifacts by review status.
 */
export function getArtifactsByStatus(
  db: Database.Database,
  status: string,
): Promise<Artifact[]> {
  const rows = db
    .prepare("SELECT * FROM team_artifacts WHERE review_status = ? ORDER BY created_at DESC")
    .all(status) as Array<{
      artifact_id: string;
      artifact_type: string;
      created_at: string;
      created_by: string;
      content_json: string;
      hash: string;
      review_status: string;
      approved_by_json: string;
    }>;
  return Promise.resolve(rows.map(deserializeArtifact));
}

function deserializeArtifact(row: {
  artifact_id: string;
  artifact_type: string;
  created_at: string;
  created_by: string;
  content_json: string;
  hash: string;
  review_status: string;
  approved_by_json: string;
}): Artifact {
  return {
    artifactId: row.artifact_id,
    artifactType: row.artifact_type,
    createdAt: row.created_at,
    createdBy: row.created_by,
    contentJson: row.content_json,
    hash: row.hash,
    reviewStatus: row.review_status,
    approvedByJson: row.approved_by_json,
  };
}
