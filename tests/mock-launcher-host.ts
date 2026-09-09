import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BrowserHost, BrowserHostObserveHandlers } from "../src/browser-host.ts";

type TabState = {
  context: BrowserContext;
  page: Page;
  observers: Set<BrowserHostObserveHandlers>;
  completeCallbacks: Set<() => void>;
  observerInstalled: boolean;
};

const composerSelectors = [
  "textarea",
  '[contenteditable="true"]',
  'div[role="textbox"]',
  "form textarea",
  "textarea[placeholder]",
];

const sendSelectors = [
  'button:has-text("Send")',
  'button[aria-label*="send"]',
  'button[aria-label*="Send"]',
  'button[type="submit"]',
  'button[title*="Send"]',
];

export function createMockLauncherHost(options: { headful?: boolean } = {}): BrowserHost {
  let browserPromise: Promise<Browser> | null = null;
  const tabs = new Map<string, TabState>();
  let nextTab = 1;

  const getBrowser = async () => {
    if (!browserPromise) {
      const headful = options.headful ?? (process.env.QWEN_HEADFUL === "1");
      browserPromise = chromium.launch({ headless: !headful });
    }
    return browserPromise;
  };

  const emitChunk = (tabId: string, chunk: string) => {
    const state = tabs.get(tabId);
    if (!state || !chunk) return;
    for (const observer of state.observers) {
      observer.onChunk(chunk);
    }
  };

  const emitComplete = (tabId: string) => {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const observer of state.observers) {
      observer.onComplete();
    }
    for (const cb of state.completeCallbacks) {
      cb();
    }
  };

  const emitError = (tabId: string, message: string) => {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const observer of state.observers) {
      observer.onError(message);
    }
  };

  const installObserver = async (tabId: string) => {
    const state = tabs.get(tabId);
    if (!state || state.observerInstalled) return;

    const { page } = state;

    await page.exposeFunction("mockLauncherHostChunk", (chunk: string) => emitChunk(tabId, chunk));
    await page.exposeFunction("mockLauncherHostComplete", () => emitComplete(tabId));
    await page.exposeFunction("mockLauncherHostError", (message: string) => emitError(tabId, message));

    await page.evaluate(() => {
      const win = window as any;
      if (win.__mockLauncherObserverInstalled) return;

      const assistantSelectors = [
        '[data-role="assistant"]',
        ".assistant",
        ".qwen-assistant",
        ".reply",
        "main",
        '[role="main"]',
      ];

      const currentAssistantText = () => {
        for (const selector of assistantSelectors) {
          try {
            const el = document.querySelector(selector);
            if (el && el.textContent && el.textContent.trim()) {
              return el.textContent.trim();
            }
          } catch {
            // no-op
          }
        }
        return "";
      };

      let last = "";
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const settleMs = 800;

      const push = () => {
        try {
          const text = currentAssistantText();
          if (!text) return;
          const chunk = text.startsWith(last) ? text.slice(last.length) : text;
          last = text;
          if (chunk) {
            win.mockLauncherHostChunk(chunk);
          }
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            win.mockLauncherHostComplete();
          }, settleMs);
        } catch (error) {
          win.mockLauncherHostError(error instanceof Error ? error.message : String(error));
        }
      };

      const observer = new MutationObserver(() => push());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      win.__mockLauncherObserverInstalled = true;
      win.__mockLauncherObserverStop = () => {
        observer.disconnect();
        if (settleTimer) clearTimeout(settleTimer);
      };
    });

    state.observerInstalled = true;
  };

  return {
    async openTab(url: string): Promise<{ tabId: string }> {
      const browser = await getBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const tabId = `mock-tab-${nextTab++}`;
      tabs.set(tabId, {
        context,
        page,
        observers: new Set(),
        completeCallbacks: new Set(),
        observerInstalled: false,
      });
      return { tabId };
    },

    async runInTab(tabId: string, payload: { action: string; prompt?: string }): Promise<void> {
      const state = tabs.get(tabId);
      if (!state) {
        throw new Error(`Unknown tab ${tabId}`);
      }
      if (payload.action !== "fillAndSend") {
        throw new Error(`Unsupported mock action: ${payload.action}`);
      }
      if (!payload.prompt) {
        throw new Error("fillAndSend requires prompt");
      }

      const { page } = state;
      await installObserver(tabId);

      let composer = null as any;
      const composerDeadline = Date.now() + Number(process.env.QWEN_COMPOSER_WAIT_MS ?? 20_000);
      while (!composer && Date.now() < composerDeadline) {
        for (const selector of composerSelectors) {
          const candidate = await page.$(selector);
          if (candidate && (await candidate.isVisible().catch(() => false))) {
            composer = candidate;
            break;
          }
        }
        if (!composer) await page.waitForTimeout(250);
      }

      if (!composer) {
        throw new Error("Composer element not found in mock host run");
      }

      try {
        await composer.click({ clickCount: 1 });
        await page.keyboard.type(payload.prompt, { delay: 8 });
      } catch {
        await composer.evaluate((el: any, text: string) => {
          if ((el as any).isContentEditable) {
            (el as HTMLElement).innerText = text;
          } else if ((el as HTMLTextAreaElement).value !== undefined) {
            (el as HTMLTextAreaElement).value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            (el as HTMLElement).textContent = text;
          }
        }, payload.prompt);
      }

      let sendButton = null as any;
      for (const selector of sendSelectors) {
        const candidate = await page.$(selector);
        if (candidate && (await candidate.isVisible().catch(() => false))) {
          sendButton = candidate;
          break;
        }
      }

      if (sendButton) {
        await sendButton.click();
      } else {
        await page.keyboard.press("Enter");
      }
    },

    observeTab(tabId: string, handlers: BrowserHostObserveHandlers): () => void {
      const state = tabs.get(tabId);
      if (!state) {
        throw new Error(`Unknown tab ${tabId}`);
      }
      state.observers.add(handlers);
      return () => {
        state.observers.delete(handlers);
      };
    },

    async closeTab(tabId: string): Promise<void> {
      const state = tabs.get(tabId);
      if (!state) return;
      try {
        await state.page.evaluate(() => {
          const win = window as any;
          if (typeof win.__mockLauncherObserverStop === "function") {
            win.__mockLauncherObserverStop();
          }
        });
      } catch {
        // no-op
      }
      await state.page.close().catch(() => undefined);
      await state.context.close().catch(() => undefined);
      tabs.delete(tabId);
      if (tabs.size === 0 && browserPromise) {
        const browser = await browserPromise;
        await browser.close().catch(() => undefined);
        browserPromise = null;
      }
    },

    onceTabComplete(tabId: string, cb: () => void): void {
      const state = tabs.get(tabId);
      if (!state) {
        throw new Error(`Unknown tab ${tabId}`);
      }
      state.completeCallbacks.add(cb);
    },
  };
}
