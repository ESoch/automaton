/**
 * Treasury Presets
 *
 * Per-role treasury policy presets. These constrain financial
 * operations for each role to prevent unauthorized spending.
 */

import type { TreasuryPolicy } from "../types.js";

export const TREASURY_PRESETS: Record<string, Partial<TreasuryPolicy>> = {
  orchestrator: {
    maxSingleTransferCents: 500,
    maxDailyTransferCents: 5000,
    minimumReserveCents: 1000,
  },
  "research-pm": {
    maxSingleTransferCents: 0,
    maxDailyTransferCents: 100,
  },
  "builder-engineer": {
    maxSingleTransferCents: 0,
    maxDailyTransferCents: 200,
  },
  "qa-evals": {
    maxSingleTransferCents: 0,
    maxDailyTransferCents: 100,
  },
  "security-compliance": {
    maxSingleTransferCents: 0,
    maxDailyTransferCents: 100,
  },
};
