/**
 * Team Module
 *
 * Cross-agent task coordination, artifact review, approval gates,
 * role configuration, and treasury presets.
 */

export { MIGRATION_V11 } from "./team-schema.js";
export {
  requestApproval,
  checkApproval,
  resolveApproval,
  getPendingApprovals,
} from "./approval-gate.js";
export type { ApprovalParams, Approval } from "./approval-gate.js";
export {
  submitForReview,
  approveArtifact,
  rejectArtifact,
  getArtifact,
  getArtifactsByStatus,
} from "./artifact-review.js";
export type { Artifact } from "./artifact-review.js";
export {
  loadRoleConfig,
  getToolFilter,
  getTreasuryOverrides,
  getGenesisPrompt,
  getSkillsToInstall,
} from "./role-config.js";
export type { RoleConfig } from "./role-config.js";
export { createTeamTools } from "./team-tools.js";
export { TREASURY_PRESETS } from "./treasury-presets.js";
