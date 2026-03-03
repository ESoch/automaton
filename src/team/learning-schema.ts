/**
 * Learning Module Schema — Migration V12
 *
 * Adds outcome tracking columns to team_tasks,
 * team_knowledge table for cross-agent learning,
 * and team_retrospectives table for post-task reviews.
 */

export const MIGRATION_V12 = `
  -- Team knowledge base for cross-agent learning
  CREATE TABLE IF NOT EXISTS team_knowledge (
    knowledge_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL,
    source_role TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    use_count INTEGER DEFAULT 0,
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_team_knowledge_category ON team_knowledge(category);
  CREATE INDEX IF NOT EXISTS idx_team_knowledge_confidence ON team_knowledge(confidence);

  -- Retrospective artifacts (link to tasks)
  CREATE TABLE IF NOT EXISTS team_retrospectives (
    retro_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL,
    what_worked_json TEXT NOT NULL DEFAULT '[]',
    what_failed_json TEXT NOT NULL DEFAULT '[]',
    lessons_json TEXT NOT NULL DEFAULT '[]',
    action_items_json TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (task_id) REFERENCES team_tasks(task_id)
  );
`;

// ALTER TABLE statements must run individually (SQLite limitation)
export const MIGRATION_V12_ALTER_OUTCOME_SCORE = `
  ALTER TABLE team_tasks ADD COLUMN outcome_score INTEGER;
`;

export const MIGRATION_V12_ALTER_OUTCOME_NOTES = `
  ALTER TABLE team_tasks ADD COLUMN outcome_notes TEXT;
`;

export const MIGRATION_V12_ALTER_REVENUE = `
  ALTER TABLE team_tasks ADD COLUMN revenue_generated_cents INTEGER DEFAULT 0;
`;

export const MIGRATION_V12_ALTER_ITERATIONS = `
  ALTER TABLE team_tasks ADD COLUMN iterations_required INTEGER DEFAULT 1;
`;
