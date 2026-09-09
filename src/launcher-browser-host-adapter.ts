import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BrowserHost,
  BrowserHostAction,
  BrowserHostObserveHandlers,
  LauncherDescriptor,
} from "./browser-host.ts";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number;
  result?: any;
  error?: { message?: string };
  method?: string;
  params?: any;
};

const DEFAULT_TIMEOUT_MS = 20_000;

function ensureDescriptor(descriptor: LauncherDescriptor): void {
  if (!descriptor.controlSocket && !descriptor.url) {
    throw new Error("Launcher descriptor must include controlSocket or url");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(`${label} timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(String(controller.signal.reason)));
        });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseEventPayload(raw: string): { type: "chunk" | "complete" | "error"; chunk?: string; message?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as JsonRpcResponse | { type?: string; chunk?: string; message?: string; text?: string };
    const eventType =
      (parsed as any).type ??
      (parsed as JsonRpcResponse).method ??
      (parsed as JsonRpcResponse).params?.type ??
      (parsed as JsonRpcResponse).params?.event;
    const params = (parsed as JsonRpcResponse).params ?? parsed;
    if (eventType && String(eventType).toLowerCase().includes("complete")) {
      return { type: "complete" };
    }
    if (eventType && String(eventType).toLowerCase().includes("error")) {
      return { type: "error", message: String(params?.message ?? params?.error ?? "Launcher event error") };
    }
    const chunk = params?.chunk ?? params?.text ?? params?.delta;
    if (typeof chunk === "string" && chunk.length > 0) {
      return { type: "chunk", chunk };
    }
    return null;
  } catch {
    return { type: "chunk", chunk: text };
  }
}

function buildHttpHeaders(descriptor: LauncherDescriptor): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(descriptor.token ? { authorization: "Bearer " + descriptor.token } : {}),
    ...(descriptor.headers ?? {}),
  };
}

async function httpRequest<T>(
  descriptor: LauncherDescriptor,
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<T> {
  if (!descriptor.url) {
    throw new Error("HTTP launcher mode requires descriptor.url");
  }
  const timeoutMs = descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, descriptor.url), {
      method,
      headers: buildHttpHeaders(descriptor),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${method} ${path} failed with ${res.status}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function createSocketRpc(descriptor: LauncherDescriptor) {
  if (!descriptor.controlSocket) {
    throw new Error("Socket launcher mode requires descriptor.controlSocket");
  }
  return async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const timeoutMs = descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return withTimeout(
      new Promise((resolve, reject) => {
        const socket = net.createConnection(descriptor.controlSocket as string);
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let buffer = "";

        socket.once("connect", () => {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let parsed: JsonRpcResponse;
            try {
              parsed = JSON.parse(line) as JsonRpcResponse;
            } catch {
              continue;
            }
            if (String(parsed.id) !== id) continue;
            if (parsed.error) {
              socket.destroy();
              reject(new Error(parsed.error.message ?? `${method} failed`));
              return;
            }
            socket.end();
            resolve(parsed.result ?? parsed.params ?? {});
            return;
          }
        });

        socket.once("error", (error) => reject(error));
        socket.once("close", () => {
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer) as JsonRpcResponse;
              if (parsed.error) reject(new Error(parsed.error.message ?? `${method} failed`));
              else resolve(parsed.result ?? parsed.params ?? {});
            } catch {
              reject(new Error(`${method} response stream ended without a complete JSON-RPC response`));
            }
          }
        });
      }),
      timeoutMs,
      `socket rpc ${method}`,
    );
  };
}

export function buildLauncherHostAdapter(descriptor: LauncherDescriptor): BrowserHost {
  ensureDescriptor(descriptor);

  const completions = new Map<string, Set<() => void>>();
  const emitComplete = (tabId: string) => {
    const callbacks = completions.get(tabId);
    if (!callbacks) return;
    for (const cb of callbacks) {
      try {
        cb();
      } catch {
        // no-op
      }
    }
  };

  const socketRpc = descriptor.controlSocket ? createSocketRpc(descriptor) : undefined;

  const callRpc = async (method: string, params: Record<string, unknown>) => {
    if (socketRpc) {
      return socketRpc(method, params);
    }
    const rpcPath = descriptor.rpcPath ?? "/rpc";
    const payload = { jsonrpc: "2.0", id: `${Date.now()}`, method, params };
    const result = await httpRequest<JsonRpcResponse>(descriptor, rpcPath, "POST", payload);
    if ((result as JsonRpcResponse)?.error) {
      throw new Error((result as JsonRpcResponse).error?.message ?? `${method} failed`);
    }
    return (result as JsonRpcResponse).result ?? (result as any);
  };

  const openTab = async (url: string): Promise<{ tabId: string }> => {
    if (descriptor.url) {
      try {
        const opened = await httpRequest<{ tabId: string }>(descriptor, "/tabs/open", "POST", { url });
        if (opened?.tabId) return opened;
      } catch {
        // Fall back to RPC endpoint contract below.
      }
    }
    const result = await callRpc("openTab", { url });
    const tabId = String(result?.tabId ?? result?.id ?? "");
    if (!tabId) throw new Error("Launcher did not return tabId from openTab");
    return { tabId };
  };

  const runInTab = async (tabId: string, payload: BrowserHostAction): Promise<void> => {
    if (payload.action === "fillAndSend" && !payload.prompt) {
      throw new Error("fillAndSend requires payload.prompt");
    }
    // `fillAndSend` maps to the launcher's page-action control surface: fill composer, then trigger send.
    if (descriptor.url) {
      try {
        await httpRequest(descriptor, `/tabs/${encodeURIComponent(tabId)}/actions`, "POST", payload);
        return;
      } catch {
        // Fall back to RPC endpoint contract below.
      }
    }
    await callRpc("runInTab", { tabId, payload });
  };

  const closeTab = async (tabId: string): Promise<void> => {
    if (descriptor.url) {
      try {
        await httpRequest(descriptor, `/tabs/${encodeURIComponent(tabId)}`, "DELETE");
        completions.delete(tabId);
        return;
      } catch {
        // Fall back to RPC endpoint contract below.
      }
    }
    await callRpc("closeTab", { tabId });
    completions.delete(tabId);
  };

  const observeTabViaSocket = (tabId: string, handlers: BrowserHostObserveHandlers): (() => void) => {
    const socketPath = descriptor.controlSocket;
    if (!socketPath) {
      return () => {};
    }

    let stop = false;
    let retries = 0;
    const maxRetries = descriptor.reconnectAttempts ?? 3;
    let activeSocket: net.Socket | null = null;

    const connect = () => {
      if (stop) return;
      const socket = net.createConnection(socketPath);
      activeSocket = socket;
      let buffer = "";

      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            method: "observeTab",
            params: { tabId },
          })}\n`,
        );
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseEventPayload(line);
          if (!event) continue;
          if (event.type === "chunk" && event.chunk) handlers.onChunk(event.chunk);
          if (event.type === "complete") {
            handlers.onComplete();
            emitComplete(tabId);
          }
          if (event.type === "error") handlers.onError(event.message ?? "Launcher tab stream error");
        }
      });

      socket.on("error", (error) => {
        handlers.onError(`Launcher socket stream error: ${error.message}`);
      });

      socket.on("close", async () => {
        if (stop) return;
        retries += 1;
        if (retries > maxRetries) {
          handlers.onError("Launcher socket stream closed and reconnection budget exhausted");
          return;
        }
        await delay(Math.min(500 * retries, 2_000));
        connect();
      });
    };

    connect();

    return () => {
      stop = true;
      activeSocket?.destroy();
    };
  };

  const observeTabViaSse = (tabId: string, handlers: BrowserHostObserveHandlers): (() => void) => {
    let stop = false;
    let retries = 0;
    const maxRetries = descriptor.reconnectAttempts ?? 3;
    const timeoutMs = descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let controller: AbortController | null = null;

    const connect = async () => {
      if (stop || !descriptor.url) return;
      controller = new AbortController();
      const headers = {
        accept: "text/event-stream",
        ...buildHttpHeaders(descriptor),
      };
      const path = descriptor.eventsPath ?? `/tabs/${encodeURIComponent(tabId)}/events`;
      const timeout = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const res = await fetch(new URL(path, descriptor.url), {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok || !res.body) {
          throw new Error(`SSE stream failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!stop) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            const dataLines = evt
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());
            const joined = dataLines.join("\n");
            if (!joined) continue;
            const parsed = parseEventPayload(joined);
            if (!parsed) continue;
            if (parsed.type === "chunk" && parsed.chunk) handlers.onChunk(parsed.chunk);
            if (parsed.type === "complete") {
              handlers.onComplete();
              emitComplete(tabId);
            }
            if (parsed.type === "error") handlers.onError(parsed.message ?? "Launcher stream error");
          }
        }
      } catch (error) {
        if (!stop) {
          handlers.onError(`Launcher SSE observe error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        clearTimeout(timeout);
        if (!stop) {
          retries += 1;
          if (retries > maxRetries) {
            handlers.onError("Launcher SSE stream ended and reconnection budget exhausted");
          } else {
            await delay(Math.min(500 * retries, 2_000));
            connect();
          }
        }
      }
    };

    void connect();

    return () => {
      stop = true;
      controller?.abort();
    };
  };

  return {
    openTab,
    runInTab,
    closeTab,
    onceTabComplete(tabId: string, cb: () => void): void {
      const callbacks = completions.get(tabId) ?? new Set<() => void>();
      callbacks.add(cb);
      completions.set(tabId, callbacks);
    },
    observeTab(tabId: string, handlers: BrowserHostObserveHandlers): () => void {
      if (descriptor.controlSocket) {
        return observeTabViaSocket(tabId, handlers);
      }
      return observeTabViaSse(tabId, handlers);
    },
  };
}
