/**
 * Role Isolation Tests
 *
 * Validates that each role's tool filter correctly allows/denies tools
 * based on allowedToolCategories and deniedTools in role configs.
 * Also tests the policy engine integration for role-based restrictions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient } from "../mocks.js";
import type { AutomatonDatabase, AutomatonTool, ToolContext, PolicyRequest } from "../../types.js";
import { getToolFilter } from "../../team/role-config.js";
import type { RoleConfig } from "../../team/role-config.js";
import { createRoleRestrictionRules } from "../../agent/policy-rules/role-restrictions.js";

// Minimal tool factory for testing filters
function mockTool(name: string, category: string): AutomatonTool {
  return {
    name,
    description: `Mock ${name}`,
    category: category as AutomatonTool["category"],
    riskLevel: "safe",
    parameters: {},
    execute: async () => "ok",
  };
}

// Role configs matching our config/roles/*.json files
const ROLE_CONFIGS: Record<string, Pick<RoleConfig, "role" | "allowedToolCategories" | "deniedTools">> = {
  orchestrator: {
    role: "orchestrator",
    allowedToolCategories: ["memory", "web", "exec", "git", "replication", "financial", "governance"],
    deniedTools: [],
  },
  "research-pm": {
    role: "research-pm",
    allowedToolCategories: ["memory", "web"],
    deniedTools: [
      "exec", "transfer_credits", "spawn_child",
      "install_mcp_server", "install_npm_package",
      "expose_port", "create_sandbox", "delete_sandbox",
    ],
  },
  "builder-engineer": {
    role: "builder-engineer",
    allowedToolCategories: ["memory", "web", "exec", "git"],
    deniedTools: [
      "transfer_credits", "spawn_child",
      "expose_port", "install_mcp_server",
    ],
  },
  "qa-evals": {
    role: "qa-evals",
    allowedToolCategories: ["memory", "web", "exec", "git"],
    deniedTools: [
      "transfer_credits", "spawn_child",
      "install_mcp_server", "install_npm_package",
      "expose_port", "create_sandbox", "delete_sandbox",
      "register_domain", "deploy",
    ],
  },
  "security-compliance": {
    role: "security-compliance",
    allowedToolCategories: ["memory", "web", "git"],
    deniedTools: [
      "transfer_credits", "spawn_child",
      "install_mcp_server", "install_npm_package",
      "expose_port", "create_sandbox", "delete_sandbox",
    ],
  },
};

describe("team role isolation", () => {
  describe("tool filter function", () => {
    it("orchestrator: allows memory, web, exec, git, replication, financial tools", () => {
      const filter = getToolFilter(ROLE_CONFIGS.orchestrator as RoleConfig);

      expect(filter(mockTool("team_create_task", "memory"))).toBe(true);
      expect(filter(mockTool("web_search", "web"))).toBe(true);
      expect(filter(mockTool("exec", "exec"))).toBe(true);
      expect(filter(mockTool("git_commit", "git"))).toBe(true);
      expect(filter(mockTool("spawn_child", "replication"))).toBe(true);
      expect(filter(mockTool("transfer_credits", "financial"))).toBe(true);
    });

    it("research-pm: only allows memory and web tools", () => {
      const filter = getToolFilter(ROLE_CONFIGS["research-pm"] as RoleConfig);

      expect(filter(mockTool("team_create_task", "memory"))).toBe(true);
      expect(filter(mockTool("web_search", "web"))).toBe(true);
      expect(filter(mockTool("git_commit", "git"))).toBe(false);
      expect(filter(mockTool("some_exec", "exec"))).toBe(false);
      expect(filter(mockTool("some_repl", "replication"))).toBe(false);
    });

    it("research-pm: denies explicitly blocked tools even in allowed categories", () => {
      const filter = getToolFilter(ROLE_CONFIGS["research-pm"] as RoleConfig);

      // exec is in deniedTools and also blocked by category
      expect(filter(mockTool("exec", "memory"))).toBe(false);
      expect(filter(mockTool("transfer_credits", "memory"))).toBe(false);
      expect(filter(mockTool("spawn_child", "memory"))).toBe(false);
    });

    it("builder-engineer: allows memory, web, exec, git but denies financial", () => {
      const filter = getToolFilter(ROLE_CONFIGS["builder-engineer"] as RoleConfig);

      expect(filter(mockTool("team_store_artifact", "memory"))).toBe(true);
      expect(filter(mockTool("exec", "exec"))).toBe(true);
      expect(filter(mockTool("git_push", "git"))).toBe(true);
      expect(filter(mockTool("some_financial", "financial"))).toBe(false);
      expect(filter(mockTool("spawn_child", "replication"))).toBe(false);
    });

    it("builder-engineer: denies transfer_credits, spawn_child, expose_port", () => {
      const filter = getToolFilter(ROLE_CONFIGS["builder-engineer"] as RoleConfig);

      expect(filter(mockTool("transfer_credits", "memory"))).toBe(false);
      expect(filter(mockTool("spawn_child", "memory"))).toBe(false);
      expect(filter(mockTool("expose_port", "memory"))).toBe(false);
    });

    it("qa-evals: allows memory, web, exec, git but has extensive denied list", () => {
      const filter = getToolFilter(ROLE_CONFIGS["qa-evals"] as RoleConfig);

      expect(filter(mockTool("team_fetch_artifact", "memory"))).toBe(true);
      expect(filter(mockTool("exec", "exec"))).toBe(true);

      // Denied tools
      expect(filter(mockTool("transfer_credits", "memory"))).toBe(false);
      expect(filter(mockTool("spawn_child", "memory"))).toBe(false);
      expect(filter(mockTool("deploy", "memory"))).toBe(false);
      expect(filter(mockTool("create_sandbox", "memory"))).toBe(false);
    });

    it("security-compliance: allows memory, web, git only — no exec", () => {
      const filter = getToolFilter(ROLE_CONFIGS["security-compliance"] as RoleConfig);

      expect(filter(mockTool("team_search_artifacts", "memory"))).toBe(true);
      expect(filter(mockTool("web_fetch", "web"))).toBe(true);
      expect(filter(mockTool("git_diff", "git"))).toBe(true);
      expect(filter(mockTool("exec", "exec"))).toBe(false);
      expect(filter(mockTool("some_financial", "financial"))).toBe(false);
    });

    it("security-compliance: denies transfer_credits, spawn_child", () => {
      const filter = getToolFilter(ROLE_CONFIGS["security-compliance"] as RoleConfig);

      expect(filter(mockTool("transfer_credits", "memory"))).toBe(false);
      expect(filter(mockTool("spawn_child", "memory"))).toBe(false);
    });

    it("all roles: allow team_* tools (memory category)", () => {
      const teamTools = [
        "team_create_task",
        "team_list_tasks",
        "team_claim_task",
        "team_complete_task",
        "team_store_artifact",
        "team_fetch_artifact",
        "team_search_artifacts",
        "team_request_approval",
        "team_broadcast_status",
        "team_direct_message",
      ];

      for (const [roleName, roleConfig] of Object.entries(ROLE_CONFIGS)) {
        const filter = getToolFilter(roleConfig as RoleConfig);
        for (const toolName of teamTools) {
          expect(
            filter(mockTool(toolName, "memory")),
            `${roleName} should allow ${toolName}`,
          ).toBe(true);
        }
      }
    });
  });

  describe("policy engine role restriction rule", () => {
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

    function createPolicyRequest(
      tool: AutomatonTool,
      roleConfigJson?: string,
    ): PolicyRequest {
      const identity = createTestIdentity();
      const config = createTestConfig();
      const ctx: ToolContext = {
        identity,
        config,
        db,
        conway: new MockConwayClient(),
        inference: new MockInferenceClient(),
      };

      if (roleConfigJson) {
        db.setKV("team.role_config", roleConfigJson);
      }

      return {
        tool,
        args: {},
        context: ctx,
        turnContext: {
          inputSource: undefined,
          turnToolCallCount: 0,
          sessionSpend: {
            recordSpend: () => {},
            getHourlySpend: () => 0,
            getDailySpend: () => 0,
            getTotalSpend: () => 0,
            checkLimit: () => ({ allowed: true }) as any,
            pruneOldRecords: () => 0,
          },
        },
      };
    }

    it("allows all tools when no role config is set", () => {
      const rules = createRoleRestrictionRules();
      const request = createPolicyRequest(mockTool("exec", "exec"));

      for (const rule of rules) {
        const result = rule.evaluate(request);
        expect(result).toBeNull(); // null = no opinion = allow
      }
    });

    it("denies tools in deniedTools list", () => {
      const rules = createRoleRestrictionRules();
      const roleConfig = JSON.stringify({
        role: "research-pm",
        allowedToolCategories: ["memory", "web"],
        deniedTools: ["exec", "transfer_credits"],
      });

      const request = createPolicyRequest(mockTool("exec", "memory"), roleConfig);

      const results = rules.map((r) => r.evaluate(request)).filter(Boolean);
      expect(results.length).toBe(1);
      expect(results[0]!.action).toBe("deny");
      expect(results[0]!.reasonCode).toBe("ROLE_TOOL_DENIED");
    });

    it("denies tools outside allowed categories", () => {
      const rules = createRoleRestrictionRules();
      const roleConfig = JSON.stringify({
        role: "research-pm",
        allowedToolCategories: ["memory", "web"],
        deniedTools: [],
      });

      const request = createPolicyRequest(mockTool("git_push", "git"), roleConfig);

      const results = rules.map((r) => r.evaluate(request)).filter(Boolean);
      expect(results.length).toBe(1);
      expect(results[0]!.action).toBe("deny");
      expect(results[0]!.reasonCode).toBe("ROLE_CATEGORY_DENIED");
    });

    it("allows tools in allowed categories", () => {
      const rules = createRoleRestrictionRules();
      const roleConfig = JSON.stringify({
        role: "research-pm",
        allowedToolCategories: ["memory", "web"],
        deniedTools: [],
      });

      const request = createPolicyRequest(mockTool("web_search", "web"), roleConfig);

      const results = rules.map((r) => r.evaluate(request)).filter(Boolean);
      expect(results.length).toBe(0);
    });

    it("explicitly denied takes precedence over category allowance", () => {
      const rules = createRoleRestrictionRules();
      // Tool is in allowed category "memory" but also explicitly denied
      const roleConfig = JSON.stringify({
        role: "custom",
        allowedToolCategories: ["memory"],
        deniedTools: ["dangerous_memory_tool"],
      });

      const request = createPolicyRequest(
        mockTool("dangerous_memory_tool", "memory"),
        roleConfig,
      );

      const results = rules.map((r) => r.evaluate(request)).filter(Boolean);
      expect(results.length).toBe(1);
      expect(results[0]!.action).toBe("deny");
      expect(results[0]!.reasonCode).toBe("ROLE_TOOL_DENIED");
    });
  });
});
