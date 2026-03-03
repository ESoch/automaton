/**
 * Plimsoll Transaction Guard
 *
 * Three-engine defense system for agent wallet protection:
 *   1. Trajectory Hash — loop detection via SHA-256 fingerprints
 *   2. Capital Velocity — spend-rate limiter per 5-minute window
 *   3. Entropy Guard — key exfiltration detection (private keys, mnemonics)
 *
 * All engines key their windows by agent ID for proper per-agent isolation.
 * Rewritten from scratch with all 7 audit fixes from PR #234.
 */

import { createHash } from "crypto";
import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";

// ─── Helpers ─────────────────────────────────────────────────────

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function quarantine(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "quarantine", reasonCode, humanMessage };
}

function getAgentId(request: PolicyRequest): string {
  return (
    request.context?.identity?.sandboxId ||
    request.context?.identity?.name ||
    "default"
  );
}

// ─── Engine 1: Trajectory Hash (Loop Detection) ─────────────────

const TRAJECTORY_WINDOW_MS = 60_000; // 60 seconds
const TRAJECTORY_BLOCK_THRESHOLD = 3;

// Per-agent windows
const trajectoryWindows = new Map<
  string,
  Array<{ hash: string; ts: number }>
>();

function createTrajectoryHashRule(): PolicyRule {
  return {
    id: "plimsoll.trajectory_hash",
    description:
      "Detects looping behavior by fingerprinting (tool, target, amount) in a 60s sliding window",
    priority: 450,
    appliesTo: {
      by: "name",
      names: ["transfer_credits", "x402_fetch", "fund_child"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const agentId = getAgentId(request);
      const target = String(request.args.target ?? request.args.url ?? "");
      const amount = String(request.args.amount ?? "0");
      const toolName = request.tool.name;

      const fingerprint = createHash("sha256")
        .update(`${toolName}:${target}:${amount}`)
        .digest("hex");

      const now = Date.now();

      // Get or create agent's window
      if (!trajectoryWindows.has(agentId)) {
        trajectoryWindows.set(agentId, []);
      }
      const window = trajectoryWindows.get(agentId)!;

      // Prune expired entries
      const cutoff = now - TRAJECTORY_WINDOW_MS;
      while (window.length > 0 && window[0].ts < cutoff) {
        window.shift();
      }

      // Add current entry
      window.push({ hash: fingerprint, ts: now });

      // Count duplicates
      const count = window.filter((e) => e.hash === fingerprint).length;

      if (count >= TRAJECTORY_BLOCK_THRESHOLD) {
        return deny(
          "plimsoll.trajectory_hash",
          "PLIMSOLL_LOOP_DETECTED",
          `Loop detected: ${toolName} called ${count} times with identical parameters in ${TRAJECTORY_WINDOW_MS / 1000}s window`,
        );
      }

      if (count === TRAJECTORY_BLOCK_THRESHOLD - 1) {
        return quarantine(
          "plimsoll.trajectory_hash",
          "PLIMSOLL_LOOP_WARNING",
          `Warning: ${toolName} called ${count} times with identical parameters — one more triggers block`,
        );
      }

      return null;
    },
  };
}

// ─── Engine 2: Capital Velocity (Spend-Rate Limiter) ─────────────

const VELOCITY_WINDOW_MS = 300_000; // 5 minutes
const VELOCITY_CAP_CENTS = 50_000; // $500
const VELOCITY_WARN_RATIO = 0.8;

// Per-agent windows
const velocityWindows = new Map<
  string,
  Array<{ amount: number; ts: number }>
>();

function createCapitalVelocityRule(): PolicyRule {
  return {
    id: "plimsoll.capital_velocity",
    description:
      "Limits cumulative spend to $500 per 5-minute window per agent",
    priority: 450,
    appliesTo: {
      by: "name",
      names: ["transfer_credits", "x402_fetch", "fund_child"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = Number(request.args.amount ?? 0);
      if (amount <= 0) return null;

      const agentId = getAgentId(request);
      const now = Date.now();

      // Get or create agent's window
      if (!velocityWindows.has(agentId)) {
        velocityWindows.set(agentId, []);
      }
      const window = velocityWindows.get(agentId)!;

      // Prune expired entries
      const cutoff = now - VELOCITY_WINDOW_MS;
      while (window.length > 0 && window[0].ts < cutoff) {
        window.shift();
      }

      // FIX: Append entry BEFORE threshold evaluation (not after)
      window.push({ amount, ts: now });

      // Sum window
      const total = window.reduce((sum, e) => sum + e.amount, 0);

      if (total > VELOCITY_CAP_CENTS) {
        return deny(
          "plimsoll.capital_velocity",
          "PLIMSOLL_VELOCITY_BREACH",
          `Velocity breach: $${(total / 100).toFixed(2)} spent in ${VELOCITY_WINDOW_MS / 60_000}-minute window (cap: $${(VELOCITY_CAP_CENTS / 100).toFixed(2)})`,
        );
      }

      if (total >= VELOCITY_CAP_CENTS * VELOCITY_WARN_RATIO) {
        return quarantine(
          "plimsoll.capital_velocity",
          "PLIMSOLL_VELOCITY_WARNING",
          `Velocity warning: $${(total / 100).toFixed(2)} of $${(VELOCITY_CAP_CENTS / 100).toFixed(2)} cap used in current window`,
        );
      }

      return null;
    },
  };
}

// ─── Engine 3: Entropy Guard (Key Exfiltration Detection) ────────

// Patterns — all case-insensitive where applicable
const ETH_KEY_RE = /0x[0-9a-fA-F]{64}/;
const ETH_KEY_BARE_RE = /\b[0-9a-fA-F]{64}\b/;
const MNEMONIC_RE = /\b([a-zA-Z]{3,8}\s+){11,}[a-zA-Z]{3,8}\b/i;

/**
 * Recursively extract all string values from an object,
 * including strings inside arrays and nested objects within arrays.
 */
function extractStringFields(
  obj: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = [];

  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;

    if (typeof v === "string") {
      results.push({ key: fullKey, value: v });
    } else if (Array.isArray(v)) {
      // FIX: Recurse into arrays (PR #234 skipped arrays)
      for (let i = 0; i < v.length; i++) {
        const elem = v[i];
        const elemKey = `${fullKey}[${i}]`;
        if (typeof elem === "string") {
          results.push({ key: elemKey, value: elem });
        } else if (elem !== null && typeof elem === "object") {
          results.push(
            ...extractStringFields(
              elem as Record<string, unknown>,
              elemKey,
            ),
          );
        }
      }
    } else if (v !== null && typeof v === "object") {
      results.push(
        ...extractStringFields(v as Record<string, unknown>, fullKey),
      );
    }
  }

  return results;
}

function createEntropyGuardRule(): PolicyRule {
  return {
    id: "plimsoll.entropy_guard",
    description:
      "Blocks tool calls containing private keys, mnemonics, or high-entropy secrets",
    priority: 450,
    appliesTo: {
      by: "name",
      names: [
        "exec",
        "x402_fetch",
        "transfer_credits",
        "send_message",
        "write_file",
        "fund_child",
      ],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // FIX: Fail-closed — wrap in try/catch, quarantine on error
      try {
        const fields = extractStringFields(
          request.args as Record<string, unknown>,
        );

        for (const { key, value } of fields) {
          // Check for 0x-prefixed Ethereum private keys
          if (ETH_KEY_RE.test(value)) {
            return deny(
              "plimsoll.entropy_guard",
              "PLIMSOLL_KEY_EXFIL",
              `Blocked: field "${key}" contains what appears to be an Ethereum private key (0x-prefixed)`,
            );
          }

          // Check for bare hex private keys (no 0x prefix)
          if (ETH_KEY_BARE_RE.test(value)) {
            // Avoid false positives on short strings or known-safe patterns
            const match = value.match(ETH_KEY_BARE_RE);
            if (match && match[0].length === 64) {
              return deny(
                "plimsoll.entropy_guard",
                "PLIMSOLL_KEY_EXFIL",
                `Blocked: field "${key}" contains what appears to be a bare hex private key`,
              );
            }
          }

          // Check for BIP-39 mnemonics (case-insensitive)
          if (MNEMONIC_RE.test(value)) {
            return deny(
              "plimsoll.entropy_guard",
              "PLIMSOLL_MNEMONIC_EXFIL",
              `Blocked: field "${key}" contains what appears to be a BIP-39 mnemonic phrase`,
            );
          }
        }

        return null;
      } catch {
        // FIX: Fail-closed — quarantine on any error
        return quarantine(
          "plimsoll.entropy_guard",
          "PLIMSOLL_ENTROPY_ERROR",
          "Entropy guard encountered an error — quarantining as precaution",
        );
      }
    },
  };
}

// ─── Export ───────────────────────────────────────────────────────

/**
 * Create all three Plimsoll guard policy rules.
 * Each invocation returns fresh rule instances but shares
 * module-level window state (keyed by agent ID for isolation).
 */
export function createPlimsollGuardRules(): PolicyRule[] {
  return [
    createTrajectoryHashRule(),
    createCapitalVelocityRule(),
    createEntropyGuardRule(),
  ];
}
