/**
 * Team Module Schema — Migration V11
 *
 * Tables for cross-agent task coordination, artifact review,
 * approval gates, and team event logging.
 */

export const MIGRATION_V11 = `
  -- === Team Module: Task Coordination ===

  CREATE TABLE IF NOT EXISTS team_tasks (
    task_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'NEW',
    title TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL,
    assigned_to TEXT,
    lease_expires_at TEXT,
    attempt_count INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 100,
    payload_json TEXT NOT NULL DEFAULT '{}',
    artifact_id TEXT,
    idempotency_key TEXT UNIQUE
  );

  CREATE INDEX IF NOT EXISTS idx_team_tasks_status ON team_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_team_tasks_assigned ON team_tasks(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_team_tasks_created_by ON team_tasks(created_by);

  -- === Team Module: Artifact Review ===

  CREATE TABLE IF NOT EXISTS team_artifacts (
    artifact_id TEXT PRIMARY KEY,
    artifact_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL,
    content_json TEXT NOT NULL,
    hash TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'DRAFT',
    approved_by_json TEXT DEFAULT '[]'
  );

  -- === Team Module: Approval Gate ===

  CREATE TABLE IF NOT EXISTS team_approvals (
    approval_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    requested_by TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_description TEXT,
    action_payload_json TEXT NOT NULL DEFAULT '{}',
    risk_assessment TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    resolved_at TEXT,
    resolved_by TEXT,
    human_notes TEXT
  );

  -- === Team Module: Event Log ===

  CREATE TABLE IF NOT EXISTS team_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    agent_id TEXT NOT NULL,
    agent_role TEXT,
    target_agent_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_team_events_type ON team_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_team_events_agent ON team_events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_team_events_timestamp ON team_events(timestamp);
`;
