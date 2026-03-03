/**
 * Role Configuration
 *
 * Loads per-role configuration files and provides helpers for
 * tool filtering, treasury overrides, genesis prompts, and skill lists.
 */

import fs from "fs";
import path from "path";
import type { AutomatonTool, TreasuryPolicy } from "../types.js";

export interface RoleConfig {
  role: string;
  displayName: string;
  genesisPromptFile: string;
  knowledgeBasePath: string;
  skillsToInstall: string[];
  allowedToolCategories: string[];
  deniedTools: string[];
  treasuryOverrides: Record<string, number>;
  modelRouting: {
    default: string;
    escalation: string;
    escalationTriggers: string[];
  };
}

/**
 * Load a role configuration from config/roles/{roleName}.json.
 * Searches relative to the repo root (two levels up from this file in dist).
 */
export function loadRoleConfig(roleName: string): RoleConfig {
  // Try several possible base paths
  const candidates = [
    path.resolve(process.cwd(), "config", "roles", `${roleName}.json`),
    path.resolve(__dirname, "..", "..", "..", "config", "roles", `${roleName}.json`),
    path.resolve(__dirname, "..", "..", "config", "roles", `${roleName}.json`),
  ];

  let configPath: string | undefined;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    throw new Error(
      `Role config not found for "${roleName}". Searched: ${candidates.join(", ")}`,
    );
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as RoleConfig;

  // Validate required fields
  if (!parsed.role || !parsed.displayName) {
    throw new Error(`Role config for "${roleName}" missing required fields (role, displayName)`);
  }

  return parsed;
}

/**
 * Create a tool filter function based on role config.
 * Returns true for tools the role is allowed to use.
 */
export function getToolFilter(roleConfig: RoleConfig): (tool: AutomatonTool) => boolean {
  const allowedCategories = new Set(roleConfig.allowedToolCategories);
  const deniedTools = new Set(roleConfig.deniedTools);

  return (tool: AutomatonTool): boolean => {
    // Explicitly denied tools are always blocked
    if (deniedTools.has(tool.name)) {
      return false;
    }
    // If no categories specified, allow all
    if (allowedCategories.size === 0) {
      return true;
    }
    // Check if tool category is in the allowed list
    return allowedCategories.has(tool.category);
  };
}

/**
 * Get treasury policy overrides from role config.
 */
export function getTreasuryOverrides(roleConfig: RoleConfig): Partial<TreasuryPolicy> {
  const overrides: Partial<TreasuryPolicy> = {};
  const map = roleConfig.treasuryOverrides;

  if (map.maxSingleTransferCents !== undefined) {
    overrides.maxSingleTransferCents = map.maxSingleTransferCents;
  }
  if (map.maxDailyTransferCents !== undefined) {
    overrides.maxDailyTransferCents = map.maxDailyTransferCents;
  }
  if (map.reserveCents !== undefined) {
    overrides.minimumReserveCents = map.reserveCents;
  }
  if (map.minimumReserveCents !== undefined) {
    overrides.minimumReserveCents = map.minimumReserveCents;
  }
  if (map.maxHourlyTransferCents !== undefined) {
    overrides.maxHourlyTransferCents = map.maxHourlyTransferCents;
  }

  return overrides;
}

/**
 * Read the genesis prompt file referenced in the role config.
 * Resolves relative paths from the config/roles/ directory.
 */
export function getGenesisPrompt(roleConfig: RoleConfig): string {
  // Resolve relative to the role config's own directory
  const candidates = [
    path.resolve(process.cwd(), "config", "roles", roleConfig.genesisPromptFile),
    path.resolve(process.cwd(), "config", "genesis-prompts", path.basename(roleConfig.genesisPromptFile)),
    path.resolve(__dirname, "..", "..", "..", "config", "roles", roleConfig.genesisPromptFile),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf-8");
    }
  }

  throw new Error(
    `Genesis prompt file not found: ${roleConfig.genesisPromptFile}. Searched: ${candidates.join(", ")}`,
  );
}

/**
 * Get the list of skill file paths to install for this role.
 */
export function getSkillsToInstall(roleConfig: RoleConfig): string[] {
  return roleConfig.skillsToInstall ?? [];
}
