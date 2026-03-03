/**
 * Market Readiness Tests
 *
 * Validates that team workflows produce market-oriented artifacts:
 * - Opportunity Briefs include monetization fields
 * - Design Docs reference MCP + x402
 * - Eval Reports include time-to-first-call metrics
 * - Security Reviews include publishable trust signals
 * - Artifact templates conform to expected structure
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient } from "../mocks.js";
import type { AutomatonDatabase, ToolContext } from "../../types.js";
import { createTeamTools } from "../../team/team-tools.js";
import { getArtifact, submitForReview, approveArtifact } from "../../team/artifact-review.js";

function createToolContext(db: AutomatonDatabase, address?: string): ToolContext {
  const identity = createTestIdentity();
  if (address) identity.address = address as `0x${string}`;
  return {
    identity,
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
}

describe("team market readiness", () => {
  let db: AutomatonDatabase;
  let tools: ReturnType<typeof createTeamTools>;

  beforeEach(() => {
    db = createTestDb();
    tools = createTeamTools();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function getTool(name: string) {
    return tools.find((t) => t.name === name)!;
  }

  describe("Opportunity Brief artifacts", () => {
    it("stores an opportunity brief with required monetization fields", async () => {
      const ctx = createToolContext(db, "0xResearcher");

      const opportunityBrief = {
        title: "Agent-Native Data Validation MCP Server",
        marketGap: "No existing MCP servers provide structured data validation with schema inference",
        willingnessToPay: {
          signals: ["Enterprise data teams spending $50k+/yr on data quality tools",
                    "3 Reddit threads requesting agent-compatible validators"],
          confidence: "medium-high",
        },
        competitorMapping: [
          { name: "great-expectations", weakness: "Not MCP-compatible, requires Python runtime" },
          { name: "zod-validator", weakness: "TypeScript-only, no agent integration" },
        ],
        deploymentComplexity: "low",
        recommendedPackaging: "MCP server with x402 metered endpoints",
        suggestedPricePoint: "$0.005/validation call",
        mcpServerSpec: {
          tools: ["validate_json", "infer_schema", "validate_batch"],
          resources: ["schemas://"],
        },
      };

      const storeResult = await getTool("team_store_artifact").execute(
        {
          artifact_type: "opportunity_brief",
          content_json: JSON.stringify(opportunityBrief),
        },
        ctx,
      );
      expect(storeResult).toContain("Artifact stored:");

      const rows = db.raw
        .prepare("SELECT * FROM team_artifacts WHERE artifact_type = 'opportunity_brief'")
        .all() as Array<{ content_json: string }>;

      expect(rows.length).toBe(1);
      const content = JSON.parse(rows[0].content_json);

      // Required monetization fields per plan
      expect(content.marketGap).toBeTruthy();
      expect(content.willingnessToPay).toBeTruthy();
      expect(content.competitorMapping).toBeTruthy();
      expect(Array.isArray(content.competitorMapping)).toBe(true);
      expect(content.suggestedPricePoint).toBeTruthy();
      expect(content.recommendedPackaging).toBeTruthy();
      expect(content.deploymentComplexity).toBeTruthy();
    });
  });

  describe("Design Doc artifacts", () => {
    it("stores a design doc with MCP + x402 references", async () => {
      const ctx = createToolContext(db, "0xBuilder");

      const designDoc = {
        title: "Data Validation MCP Server — Design Doc",
        mcpServerJson: {
          name: "data-validator",
          version: "1.0.0",
          tools: ["validate_json", "infer_schema"],
          resources: ["schemas://custom"],
        },
        x402Endpoint: {
          path: "/validate",
          method: "POST",
          pricePerCall: 0.005,
          currency: "USD",
          paymentProtocol: "x402",
        },
        installToFirstCall: {
          estimatedMinutes: 8,
          steps: [
            "npm install @data-validator/mcp-server",
            "Configure MCP client with server URL",
            "Call validate_json tool with sample data",
          ],
        },
        pricingModel: {
          freeTier: "100 calls/month",
          paid: "$0.005/call after free tier",
          enterprise: "Custom pricing, volume discounts",
        },
      };

      await getTool("team_store_artifact").execute(
        {
          artifact_type: "design_doc",
          content_json: JSON.stringify(designDoc),
        },
        ctx,
      );

      const rows = db.raw
        .prepare("SELECT * FROM team_artifacts WHERE artifact_type = 'design_doc'")
        .all() as Array<{ content_json: string }>;

      const content = JSON.parse(rows[0].content_json);

      // MCP server spec
      expect(content.mcpServerJson).toBeTruthy();
      expect(content.mcpServerJson.tools).toBeTruthy();

      // x402 endpoint
      expect(content.x402Endpoint).toBeTruthy();
      expect(content.x402Endpoint.pricePerCall).toBeGreaterThan(0);
      expect(content.x402Endpoint.paymentProtocol).toBe("x402");

      // Install-to-first-call under 10 minutes
      expect(content.installToFirstCall).toBeTruthy();
      expect(content.installToFirstCall.estimatedMinutes).toBeLessThanOrEqual(10);

      // Pricing model
      expect(content.pricingModel).toBeTruthy();
    });
  });

  describe("Eval Report artifacts", () => {
    it("stores an eval report with market-readiness checks", async () => {
      const ctx = createToolContext(db, "0xQA");

      const evalReport = {
        title: "Data Validation MCP Server — Eval Report",
        functionalTests: {
          totalTests: 45,
          passed: 43,
          failed: 2,
          coverage: 0.87,
          failingTests: [
            "validate_json handles nested nulls",
            "infer_schema with circular refs",
          ],
        },
        marketReadiness: {
          timeToFirstCall: {
            measuredMinutes: 7,
            target: 10,
            pass: true,
          },
          outputQuality: {
            description: "Validation results are clear and actionable",
            sampleOutputScore: 4.2,
            maxScore: 5,
          },
          regressionDetected: false,
        },
        publishableScorecard: {
          reliability: "96% uptime in 7-day soak test",
          accuracy: "98.5% correct validations on benchmark dataset",
          latency: "p50: 12ms, p99: 89ms",
          recommendation: "Ready for beta launch",
        },
      };

      await getTool("team_store_artifact").execute(
        {
          artifact_type: "eval_report",
          content_json: JSON.stringify(evalReport),
        },
        ctx,
      );

      const rows = db.raw
        .prepare("SELECT * FROM team_artifacts WHERE artifact_type = 'eval_report'")
        .all() as Array<{ content_json: string }>;

      const content = JSON.parse(rows[0].content_json);

      // Functional test results
      expect(content.functionalTests).toBeTruthy();
      expect(content.functionalTests.totalTests).toBeGreaterThan(0);

      // Market readiness
      expect(content.marketReadiness).toBeTruthy();
      expect(content.marketReadiness.timeToFirstCall).toBeTruthy();
      expect(content.marketReadiness.timeToFirstCall.measuredMinutes).toBeLessThanOrEqual(10);

      // Publishable scorecard
      expect(content.publishableScorecard).toBeTruthy();
    });
  });

  describe("Security Review artifacts", () => {
    it("stores a security review with publishable trust signals", async () => {
      const ctx = createToolContext(db, "0xSecurity");

      const securityReview = {
        title: "Data Validation MCP Server — Security Review",
        owaspRiskAssessment: {
          toolPoisoning: { risk: "low", mitigation: "Input sanitization on all tool calls" },
          promptInjection: { risk: "medium", mitigation: "Content filtering on validation payloads" },
          excessivePermissions: { risk: "low", mitigation: "Read-only access, no file system writes" },
          insecureOutputHandling: { risk: "low", mitigation: "Structured JSON output only" },
        },
        permissionDiff: {
          added: ["network:outbound:validation-api"],
          removed: [],
          unchanged: ["memory:read", "memory:write"],
          assessment: "Minimal permission footprint. Only new permission is outbound network for API calls.",
        },
        threatModelSummary: {
          attackSurface: "User-provided JSON payloads",
          primaryThreats: ["Malformed input causing DoS", "Large payload memory exhaustion"],
          mitigations: ["Input size limits (1MB)", "Timeout on validation (5s)"],
        },
        publishableTrustSignals: {
          verifiedBadge: true,
          permissionDiffPublished: true,
          signedReport: false,
          owaspCoverage: "4/4 agent risks assessed",
          recommendation: "Approved for registry listing",
        },
      };

      await getTool("team_store_artifact").execute(
        {
          artifact_type: "security_review",
          content_json: JSON.stringify(securityReview),
        },
        ctx,
      );

      const rows = db.raw
        .prepare("SELECT * FROM team_artifacts WHERE artifact_type = 'security_review'")
        .all() as Array<{ content_json: string }>;

      const content = JSON.parse(rows[0].content_json);

      // OWASP risk assessment
      expect(content.owaspRiskAssessment).toBeTruthy();
      expect(content.owaspRiskAssessment.toolPoisoning).toBeTruthy();

      // Permission diff
      expect(content.permissionDiff).toBeTruthy();
      expect(content.permissionDiff.assessment).toBeTruthy();

      // Threat model
      expect(content.threatModelSummary).toBeTruthy();

      // Publishable trust signals
      expect(content.publishableTrustSignals).toBeTruthy();
      expect(content.publishableTrustSignals.owaspCoverage).toBeTruthy();
    });
  });

  describe("full shipping pipeline", () => {
    it("artifact flows through DRAFT → IN_REVIEW → APPROVED pipeline", async () => {
      const researchCtx = createToolContext(db, "0xResearcher");
      const orchestratorCtx = createToolContext(db, "0xOrchestrator");

      // Research creates Opportunity Brief
      await getTool("team_store_artifact").execute(
        {
          artifact_type: "opportunity_brief",
          content_json: JSON.stringify({
            title: "Test Opportunity",
            marketGap: "Identified gap",
            willingnessToPay: "High",
            suggestedPricePoint: "$0.01",
          }),
        },
        researchCtx,
      );

      const artifactRow = db.raw
        .prepare("SELECT artifact_id FROM team_artifacts")
        .get() as { artifact_id: string };

      // Verify starts as DRAFT
      let artifact = await getArtifact(db.raw, artifactRow.artifact_id);
      expect(artifact!.reviewStatus).toBe("DRAFT");

      // Submit for review
      await submitForReview(db.raw, artifactRow.artifact_id);
      artifact = await getArtifact(db.raw, artifactRow.artifact_id);
      expect(artifact!.reviewStatus).toBe("IN_REVIEW");

      // Orchestrator approves
      await approveArtifact(db.raw, artifactRow.artifact_id, "0xOrchestrator");
      artifact = await getArtifact(db.raw, artifactRow.artifact_id);
      expect(artifact!.reviewStatus).toBe("APPROVED");

      const approvedBy = JSON.parse(artifact!.approvedByJson);
      expect(approvedBy).toContain("0xOrchestrator");
    });

    it("multiple artifact types can exist in the same pipeline", async () => {
      const ctx = createToolContext(db);

      const artifactTypes = [
        "opportunity_brief",
        "design_doc",
        "eval_report",
        "security_review",
      ];

      for (const type of artifactTypes) {
        await getTool("team_store_artifact").execute(
          {
            artifact_type: type,
            content_json: JSON.stringify({ title: `Test ${type}` }),
            skip_validation: true,
          },
          ctx,
        );
      }

      const search = await getTool("team_search_artifacts").execute({}, ctx);
      const artifacts = JSON.parse(search);
      expect(artifacts.length).toBe(4);

      const types = artifacts.map((a: { artifact_type: string }) => a.artifact_type);
      for (const type of artifactTypes) {
        expect(types).toContain(type);
      }
    });
  });
});
