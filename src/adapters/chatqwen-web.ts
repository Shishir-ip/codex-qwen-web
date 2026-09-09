import type { BrowserHost } from "../browser-host.ts";

function extractPrompt(parsedRequest: any): string {
  try {
    if (parsedRequest && typeof parsedRequest === "object") {
      const raw = parsedRequest._rawBody ?? parsedRequest;
      if (raw && Array.isArray(raw.input)) {
        return raw.input.map((i: any) => (typeof i === "string" ? i : i?.text ?? "")).join("\n");
      }
      const maybe = parsedRequest.input ?? parsedRequest.message ?? parsedRequest.prompt;
      if (typeof maybe === "string") return maybe;
    }
    if (typeof parsedRequest === "string") return parsedRequest;
    return String(parsedRequest ?? "").slice(0, 4_000);
  } catch {
    return String(parsedRequest ?? "").slice(0, 4_000);
  }
}

export function createQwenWebAdapter(provider: { browserHost: BrowserHost; url?: string }) {
  const browserHost = provider.browserHost;
  const url = provider.url ?? "https://chat.qwen.ai/";

  if (!browserHost) {
    throw new Error("Qwen web adapter requires browserHost");
  }

  return {
    runTurn: async function runTurn(
      parsedRequest: any,
      context: { headers?: Headers; abortSignal?: AbortSignal } = {},
      onEvent: (e: any) => void,
    ) {
      const abortSignal = context?.abortSignal;
      if (abortSignal?.aborted) {
        onEvent({ type: "error", message: "Turn aborted before start" });
        return;
      }

      const MAX_RESPONSE_WAIT_MS = Number(process.env.QWEN_RESPONSE_WAIT_MS ?? 120000);
      const prompt = extractPrompt(parsedRequest);

      let tabId: string | undefined;
      let unsub: (() => void) | undefined;
      let done = false;
      let settleCompletion: (() => void) | undefined;

      const markDone = () => {
        if (done) return;
        done = true;
      };

      try {
        const opened = await browserHost.openTab(url);
        tabId = opened.tabId;

        const completion = new Promise<void>((resolve) => {
          settleCompletion = resolve;
          browserHost.onceTabComplete(tabId, () => {
            if (!done) {
              onEvent({ type: "completed" });
              markDone();
            }
            resolve();
          });
        });

        unsub = browserHost.observeTab(tabId, {
          onChunk: (chunk) => {
            if (!done && chunk) onEvent({ type: "response-chunk", text: chunk });
          },
          onComplete: () => {
            if (!done) {
              onEvent({ type: "completed" });
              markDone();
            }
            settleCompletion?.();
          },
          onError: (message) => {
            onEvent({ type: "error", message });
            markDone();
            settleCompletion?.();
          },
        });

        await browserHost.runInTab(tabId, { action: "fillAndSend", prompt });

        await Promise.race([
          completion,
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`Response timeout after ${MAX_RESPONSE_WAIT_MS}ms`)), MAX_RESPONSE_WAIT_MS);
          }),
        ]);
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: "error", message });
      } finally {
        try {
          if (unsub) unsub();
        } catch {
          // no-op
        }
        try {
          if (tabId) await browserHost.closeTab(tabId);
        } catch {
          // no-op
        }
      }
    },
  };
}
