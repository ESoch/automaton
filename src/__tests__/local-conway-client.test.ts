/**
 * Local Conway Client Tests
 *
 * Verifies the local-only Conway client mock returns seeded balances
 * without HTTP calls and throws clear errors for Conway-specific operations.
 */

import { describe, it, expect } from "vitest";
import { createLocalConwayClient } from "../../../scripts/lib/local-conway-client.js";

describe("createLocalConwayClient", () => {
  it("getCreditsBalance returns seeded balance without HTTP call", async () => {
    const client = createLocalConwayClient(200);
    const balance = await client.getCreditsBalance();
    expect(balance).toBe(200);
  });

  it("getCreditsBalance uses default 200 cents when no arg provided", async () => {
    const client = createLocalConwayClient();
    const balance = await client.getCreditsBalance();
    expect(balance).toBe(200);
  });

  it("getCreditsPricing returns empty array", async () => {
    const client = createLocalConwayClient();
    const pricing = await client.getCreditsPricing();
    expect(pricing).toEqual([]);
  });

  it("transferCredits rejects with clear error", async () => {
    const client = createLocalConwayClient();
    await expect(client.transferCredits("0x123", 100)).rejects.toThrow(
      "Conway API not configured",
    );
  });

  it("listModels returns empty array", async () => {
    const client = createLocalConwayClient();
    const models = await client.listModels();
    expect(models).toEqual([]);
  });

  it("listSandboxes returns empty array", async () => {
    const client = createLocalConwayClient();
    const sandboxes = await client.listSandboxes();
    expect(sandboxes).toEqual([]);
  });

  it("createSandbox rejects with clear error", async () => {
    const client = createLocalConwayClient();
    await expect(client.createSandbox({})).rejects.toThrow(
      "Conway API not configured",
    );
  });

  it("deleteSandbox rejects with clear error", async () => {
    const client = createLocalConwayClient();
    await expect(client.deleteSandbox("some-id")).rejects.toThrow(
      "Conway API not configured",
    );
  });

  it("sandbox exec rejects with clear error", async () => {
    const client = createLocalConwayClient();
    // Note: client.exec is the Conway sandbox exec method, not child_process.exec
    await expect(client.exec("ls")).rejects.toThrow(
      "Conway API not configured",
    );
  });

  it("createScopedClient returns another local mock", async () => {
    const client = createLocalConwayClient(300);
    const scoped = client.createScopedClient("target-sandbox");
    const balance = await scoped.getCreditsBalance();
    expect(balance).toBe(300);
  });
});
