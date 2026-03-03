/**
 * Approval Gate
 *
 * Human-in-the-loop approval workflow for high-risk team actions.
 * All approvals are tracked in the team_approvals table.
 */

import { ulid } from "ulid";
import type Database from "better-sqlite3";

export interface ApprovalParams {
  requestedBy: string;
  actionType: string;
  actionDescription?: string;
  actionPayload?: Record<string, unknown>;
  riskAssessment?: string;
}

export interface Approval {
  approvalId: string;
  createdAt: string;
  requestedBy: string;
  actionType: string;
  actionDescription: string | null;
  actionPayloadJson: string;
  riskAssessment: string | null;
  status: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  humanNotes: string | null;
}

/**
 * Create a new PENDING approval request. Returns the approval_id.
 */
export function requestApproval(
  db: Database.Database,
  params: ApprovalParams,
): Promise<string> {
  const approvalId = ulid();
  db.prepare(
    `INSERT INTO team_approvals (approval_id, requested_by, action_type, action_description, action_payload_json, risk_assessment)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    approvalId,
    params.requestedBy,
    params.actionType,
    params.actionDescription ?? null,
    JSON.stringify(params.actionPayload ?? {}),
    params.riskAssessment ?? null,
  );
  return Promise.resolve(approvalId);
}

/**
 * Check the current status of an approval request.
 */
export function checkApproval(
  db: Database.Database,
  approvalId: string,
): Promise<{ status: string; humanNotes: string | null }> {
  const row = db
    .prepare("SELECT status, human_notes FROM team_approvals WHERE approval_id = ?")
    .get(approvalId) as { status: string; human_notes: string | null } | undefined;
  if (!row) {
    return Promise.resolve({ status: "NOT_FOUND", humanNotes: null });
  }
  return Promise.resolve({ status: row.status, humanNotes: row.human_notes });
}

/**
 * Resolve a pending approval with APPROVED or DENIED.
 */
export function resolveApproval(
  db: Database.Database,
  approvalId: string,
  decision: "APPROVED" | "DENIED",
  resolvedBy: string,
  notes?: string,
): Promise<void> {
  const result = db
    .prepare(
      `UPDATE team_approvals
       SET status = ?, resolved_at = datetime('now'), resolved_by = ?, human_notes = ?
       WHERE approval_id = ? AND status = 'PENDING'`,
    )
    .run(decision, resolvedBy, notes ?? null, approvalId);
  if (result.changes === 0) {
    return Promise.reject(
      new Error(`Approval ${approvalId} not found or already resolved`),
    );
  }
  return Promise.resolve();
}

/**
 * List all PENDING approvals.
 */
export function getPendingApprovals(
  db: Database.Database,
): Promise<Approval[]> {
  const rows = db
    .prepare("SELECT * FROM team_approvals WHERE status = 'PENDING' ORDER BY created_at ASC")
    .all() as Array<{
      approval_id: string;
      created_at: string;
      requested_by: string;
      action_type: string;
      action_description: string | null;
      action_payload_json: string;
      risk_assessment: string | null;
      status: string;
      resolved_at: string | null;
      resolved_by: string | null;
      human_notes: string | null;
    }>;
  return Promise.resolve(
    rows.map((r) => ({
      approvalId: r.approval_id,
      createdAt: r.created_at,
      requestedBy: r.requested_by,
      actionType: r.action_type,
      actionDescription: r.action_description,
      actionPayloadJson: r.action_payload_json,
      riskAssessment: r.risk_assessment,
      status: r.status,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
      humanNotes: r.human_notes,
    })),
  );
}
