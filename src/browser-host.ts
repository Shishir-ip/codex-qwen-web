export type BrowserHostAction = {
  action: string;
  prompt?: string;
};

export type BrowserHostObserveHandlers = {
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  onError: (message: string) => void;
};

export interface BrowserHost {
  openTab(url: string): Promise<{ tabId: string }>;
  runInTab(tabId: string, payload: BrowserHostAction): Promise<void>;
  observeTab(tabId: string, handlers: BrowserHostObserveHandlers): () => void;
  closeTab(tabId: string): Promise<void>;
  onceTabComplete(tabId: string, cb: () => void): void;
}

export type LauncherDescriptor = {
  controlSocket?: string;
  url?: string;
  rpcPath?: string;
  eventsPath?: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  reconnectAttempts?: number;
};
