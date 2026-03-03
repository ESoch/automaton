/**
 * Role-Based Restriction Policy Rules
 *
 * Checks the agent's role configuration and denies tools that are not
 * in the allowed categories or are explicitly denied for that role.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Deny tools that are not in the role's allowed categories
 * or are explicitly in the denied list.
 *
 * The role config is read from the agent's KV store (team.role_config).
 * If no role config is set, all tools are allowed (permissive default).
 */
function createRoleToolRestrictionRule(): PolicyRule {
  return {
    id: "role.tool_restriction",
    description:
      "Deny tools not in the agent's allowed categories or explicitly denied by role config",
    priority: 350,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // Read role config from KV store
      let roleConfigRaw: string | undefined;
      try {
        roleConfigRaw = request.context.db.getKV("team.role_config");
      } catch {
        // KV store may not be available
        return null;
      }

      if (!roleConfigRaw) {
        // No role config set — permissive default
        return null;
      }

      let roleConfig: {
        allowedToolCategories?: string[];
        deniedTools?: string[];
        role?: string;
      };
      try {
        roleConfig = JSON.parse(roleConfigRaw);
      } catch {
        return null;
      }

      // Check explicitly denied tools
      const deniedTools = roleConfig.deniedTools ?? [];
      if (deniedTools.includes(request.tool.name)) {
        return deny(
          "role.tool_restriction",
          "ROLE_TOOL_DENIED",
          `Tool "${request.tool.name}" is explicitly denied for role "${roleConfig.role ?? "unknown"}"`,
        );
      }

      // Check allowed categories
      const allowedCategories = roleConfig.allowedToolCategories ?? [];
      if (allowedCategories.length === 0) {
        // No category restrictions
        return null;
      }

      if (!allowedCategories.includes(request.tool.category)) {
        return deny(
          "role.tool_restriction",
          "ROLE_CATEGORY_DENIED",
          `Tool "${request.tool.name}" (category: ${request.tool.category}) is not in allowed categories [${allowedCategories.join(", ")}] for role "${roleConfig.role ?? "unknown"}"`,
        );
      }

      return null;
    },
  };
}

/**
 * Create all role-based policy rules.
 */
export function createRoleRestrictionRules(): PolicyRule[] {
  return [createRoleToolRestrictionRule()];
}
