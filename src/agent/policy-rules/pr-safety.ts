/**
 * PR Safety Policy Rules
 *
 * Validates branch names and targets for the create_pull_request tool.
 * Prevents PRs from protected branches and shell metacharacter injection
 * in branch names.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";

const BRANCH_NAME_RE = /^[a-zA-Z0-9\/_.-]+$/;

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function createProtectedBranchRule(): PolicyRule {
  return {
    id: "pr.protected_branch",
    description: "Block PRs where source branch is main or master",
    priority: 350,
    appliesTo: {
      by: "name",
      names: ["create_pull_request"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const branch = request.args.branch as string | undefined;
      if (!branch) return null;

      if (branch === "main" || branch === "master") {
        return deny(
          "pr.protected_branch",
          "PROTECTED_BRANCH",
          `Cannot create PR from protected branch '${branch}'`,
        );
      }
      return null;
    },
  };
}

function createBranchNameValidationRule(): PolicyRule {
  return {
    id: "pr.branch_name_validation",
    description: "Block PRs with shell metacharacters in branch name",
    priority: 350,
    appliesTo: {
      by: "name",
      names: ["create_pull_request"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const branch = request.args.branch as string | undefined;
      if (!branch) return null;

      if (!BRANCH_NAME_RE.test(branch)) {
        return deny(
          "pr.branch_name_validation",
          "INVALID_BRANCH_NAME",
          `Branch name contains invalid characters: '${branch.slice(0, 50)}'. Must match ${BRANCH_NAME_RE}`,
        );
      }
      return null;
    },
  };
}

function createBaseRestrictionRule(): PolicyRule {
  return {
    id: "pr.base_restriction",
    description: "Restrict PR base to main only",
    priority: 350,
    appliesTo: {
      by: "name",
      names: ["create_pull_request"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const base = request.args.base as string | undefined;
      if (!base) return null; // default is main, which is fine

      if (base !== "main") {
        return deny(
          "pr.base_restriction",
          "RESTRICTED_BASE",
          `PR base must be 'main', got '${base}'`,
        );
      }
      return null;
    },
  };
}

export function createPrSafetyRules(): PolicyRule[] {
  return [
    createProtectedBranchRule(),
    createBranchNameValidationRule(),
    createBaseRestrictionRule(),
  ];
}
