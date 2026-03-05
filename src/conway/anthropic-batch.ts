/**
 * Anthropic Batch API Client
 *
 * Queues inference requests and submits them as a batch for 50% cost reduction.
 * Best for async workloads: Research-PM scans, QA eval runs, Chronicler drafts.
 *
 * API reference: POST /v1/messages/batches
 */

import { ResilientHttpClient } from "./http-client.js";

export interface AnthropicBatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: Array<Record<string, unknown>>;
    system?: unknown;
    tools?: unknown[];
    tool_choice?: unknown;
  };
}

export interface AnthropicBatchResult {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "expired";
    message?: any;
    error?: { type: string; message: string };
  };
}

export type BatchStatus = "in_progress" | "ended" | "canceling" | "canceled";

interface QueuedRequest {
  request: AnthropicBatchRequest;
  resolve: (result: AnthropicBatchResult) => void;
  reject: (error: Error) => void;
}

const BATCH_POLL_INTERVAL_MS = 10_000;
const BATCH_MAX_POLL_ATTEMPTS = 360; // 1 hour max

export class AnthropicBatchClient {
  private queue: QueuedRequest[] = [];
  private apiKey: string;
  private httpClient: ResilientHttpClient;

  constructor(apiKey: string, httpClient: ResilientHttpClient) {
    this.apiKey = apiKey;
    this.httpClient = httpClient;
  }

  /** Queue a request for batching. Returns a promise that resolves when the batch completes. */
  enqueue(request: AnthropicBatchRequest): Promise<AnthropicBatchResult> {
    return new Promise<AnthropicBatchResult>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
    });
  }

  /** Number of queued requests awaiting flush. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Submit all queued requests as a batch, poll for completion, and resolve promises. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = [...this.queue];
    this.queue = [];

    const requests = batch.map((b) => b.request);

    try {
      // Submit batch
      const resp = await this.httpClient.request(
        "https://api.anthropic.com/v1/messages/batches",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ requests }),
          timeout: 60_000,
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`Batch submit failed: ${resp.status}: ${text}`);
        for (const b of batch) b.reject(err);
        return;
      }

      const batchData = (await resp.json()) as any;
      const batchId: string = batchData.id;

      // Poll for completion
      const results = await this.pollUntilComplete(batchId);

      // Resolve individual promises
      const resultMap = new Map<string, AnthropicBatchResult>();
      for (const r of results) {
        resultMap.set(r.custom_id, r);
      }

      for (const b of batch) {
        const result = resultMap.get(b.request.custom_id);
        if (result) {
          b.resolve(result);
        } else {
          b.reject(new Error(`No result for batch request ${b.request.custom_id}`));
        }
      }
    } catch (err) {
      for (const b of batch) {
        b.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** Poll a batch until it reaches "ended" status. */
  private async pollUntilComplete(batchId: string): Promise<AnthropicBatchResult[]> {
    for (let attempt = 0; attempt < BATCH_MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(BATCH_POLL_INTERVAL_MS);

      const status = await this.getBatchStatus(batchId);

      if (status === "ended") {
        return this.getResults(batchId);
      }

      if (status === "canceled" || status === "canceling") {
        throw new Error(`Batch ${batchId} was canceled`);
      }
    }

    throw new Error(`Batch ${batchId} timed out after polling`);
  }

  /** Get the current status of a batch. */
  async getBatchStatus(batchId: string): Promise<BatchStatus> {
    const resp = await this.httpClient.request(
      `https://api.anthropic.com/v1/messages/batches/${batchId}`,
      {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: 30_000,
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Batch status check failed: ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as any;
    return data.processing_status as BatchStatus;
  }

  /** Get results from a completed batch. */
  async getResults(batchId: string): Promise<AnthropicBatchResult[]> {
    const resp = await this.httpClient.request(
      `https://api.anthropic.com/v1/messages/batches/${batchId}/results`,
      {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: 60_000,
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Batch results fetch failed: ${resp.status}: ${text}`);
    }

    // Results come as JSONL (one JSON object per line)
    const text = await resp.text();
    const results: AnthropicBatchResult[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        results.push(JSON.parse(trimmed) as AnthropicBatchResult);
      }
    }

    return results;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
