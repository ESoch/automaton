/**
 * Treasury Presets Tests
 *
 * Validates per-role treasury policy presets and that
 * getTreasuryOverrides correctly maps config to TreasuryPolicy.
 */

import { describe, it, expect } from "vitest";
import { TREASURY_PRESETS } from "../../team/treasury-presets.js";
import { getTreasuryOverrides } from "../../team/role-config.js";
import type { RoleConfig } from "../../team/role-config.js";

describe("team treasury presets", () => {
  it("defines presets for all 5 roles", () => {
    const expectedRoles = [
      "orchestrator",
      "research-pm",
      "builder-engineer",
      "qa-evals",
      "security-compliance",
    ];

    for (const role of expectedRoles) {
      expect(TREASURY_PRESETS[role]).toBeDefined();
    }
  });

  it("orchestrator has the highest spending limits", () => {
    const orch = TREASURY_PRESETS.orchestrator;
    expect(orch.maxSingleTransferCents).toBe(500);
    expect(orch.maxDailyTransferCents).toBe(5000);
    expect(orch.minimumReserveCents).toBe(1000);
  });

  it("specialist roles have zero single-transfer limit", () => {
    const specialists = ["research-pm", "builder-engineer", "qa-evals", "security-compliance"];

    for (const role of specialists) {
      expect(TREASURY_PRESETS[role].maxSingleTransferCents).toBe(0);
    }
  });

  it("builder-engineer has slightly higher daily limit than others", () => {
    expect(TREASURY_PRESETS["builder-engineer"].maxDailyTransferCents).toBe(200);
    expect(TREASURY_PRESETS["research-pm"].maxDailyTransferCents).toBe(100);
    expect(TREASURY_PRESETS["qa-evals"].maxDailyTransferCents).toBe(100);
    expect(TREASURY_PRESETS["security-compliance"].maxDailyTransferCents).toBe(100);
  });

  it("getTreasuryOverrides maps config to TreasuryPolicy fields", () => {
    const roleConfig = {
      role: "orchestrator",
      treasuryOverrides: {
        maxSingleTransferCents: 500,
        maxDailyTransferCents: 5000,
        reserveCents: 1000,
      },
    } as unknown as RoleConfig;

    const overrides = getTreasuryOverrides(roleConfig);
    expect(overrides.maxSingleTransferCents).toBe(500);
    expect(overrides.maxDailyTransferCents).toBe(5000);
    expect(overrides.minimumReserveCents).toBe(1000);
  });

  it("getTreasuryOverrides handles minimumReserveCents alias", () => {
    const roleConfig = {
      role: "test",
      treasuryOverrides: {
        minimumReserveCents: 2000,
      },
    } as unknown as RoleConfig;

    const overrides = getTreasuryOverrides(roleConfig);
    expect(overrides.minimumReserveCents).toBe(2000);
  });

  it("getTreasuryOverrides handles maxHourlyTransferCents", () => {
    const roleConfig = {
      role: "test",
      treasuryOverrides: {
        maxHourlyTransferCents: 300,
      },
    } as unknown as RoleConfig;

    const overrides = getTreasuryOverrides(roleConfig);
    expect(overrides.maxHourlyTransferCents).toBe(300);
  });

  it("getTreasuryOverrides returns empty object for no overrides", () => {
    const roleConfig = {
      role: "test",
      treasuryOverrides: {},
    } as unknown as RoleConfig;

    const overrides = getTreasuryOverrides(roleConfig);
    expect(Object.keys(overrides).length).toBe(0);
  });
});
