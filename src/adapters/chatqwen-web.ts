import { chromium } from "playwright-core";

export function createQwenWebAdapter(provider: any) {
  return {
    runTurn: async function runTurn(parsedRequest: any, context: { headers?: Headers; abortSignal?: AbortSignal } = {}, onEvent: (e: any) => void) {
      const abortSignal = context?.abortSignal;
      if (abortSignal?.aborted) {
        onEvent({ type: "error", message: "Turn aborted before start" });
        return;
      }

      const url = "https://chat.qwen.ai/";
      let browser: any = null;
      let page: any = null;

      const HEADFUL = Boolean(process.env.QWEN_HEADFUL && process.env.QWEN_HEADFUL !== "0");
      const MAX_COMPOSER_WAIT_MS = Number(process.env.QWEN_COMPOSER_WAIT_MS ?? 20000);
      const MAX_RESPONSE_WAIT_MS = Number(process.env.QWEN_RESPONSE_WAIT_MS ?? 120000);

      const composerSelectors = [
        'textarea',
        '[contenteditable="true"]',
        'div[role="textbox"]',
        'form textarea',
        'textarea[placeholder]'
      ];
      const sendSelectors = [
        'button:has-text("Send")',
        'button[aria-label*="send"]',
        'button[type="submit"]',
        'button:has(svg)',
        'button[title*="Send"]',
      ];
      const messageContainerCandidates = [
        '[data-role="conversation"]',
        '.qwen-chat-item',
        '.chat-message',
        '.message',
        'main',
        '[role="log"]',
        '.chat-history',
        '.chat-container',
      ];

      try {
        browser = await chromium.launch({ headless: !HEADFUL });
        const context = await browser.newContext();
        page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(800);

        // Expose functions so the page can push chunks to Node without polling.
        let lastText = '';
        await page.exposeFunction('qwenAdapter_chunk', (fullText: string) => {
          try {
            if (!fullText) return;
            const chunk = fullText.startsWith(lastText) ? fullText.slice(lastText.length) : fullText;
            lastText = fullText;
            if (chunk) onEvent({ type: 'response-chunk', text: chunk });
          } catch (e) {
            // swallow
          }
        });
        await page.exposeFunction('qwenAdapter_complete', () => {
          onEvent({ type: 'completed' });
        });
        await page.exposeFunction('qwenAdapter_error', (message: string) => {
          onEvent({ type: 'error', message });
        });

        // Discover composer element
        let composerHandle: any = null;
        const composerStart = Date.now();
        while (!composerHandle && (Date.now() - composerStart) < MAX_COMPOSER_WAIT_MS) {
          for (const sel of composerSelectors) {
            try {
              const h = await page.$(sel);
              if (h) {
                const visible = await h.isVisible().catch(() => false);
                const editable = await page.evaluate(el => (el as HTMLElement).isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT', h).catch(() => false);
                if (visible && editable) { composerHandle = h; break; }
              }
            } catch {}
          }
          if (!composerHandle) await page.waitForTimeout(300);
        }

        if (!composerHandle) {
          onEvent({ type: 'error', message: 'Composer element not found within timeout (unauthenticated probe).' });
          try { await browser.close(); } catch {}
          return;
        }

        // Prepare prompt
        const prompt = (() => {
          try {
            if (parsedRequest && typeof parsedRequest === 'object') {
              const raw = parsedRequest._rawBody ?? parsedRequest;
              if (raw && Array.isArray(raw.input)) return raw.input.map((i: any) => (typeof i === 'string' ? i : i?.text ?? '')).join('\n');
              if (typeof parsedRequest === 'string') return parsedRequest;
              const maybe = parsedRequest.input ?? parsedRequest.message ?? parsedRequest.prompt;
              if (typeof maybe === 'string') return maybe;
            }
            return String(parsedRequest ?? '').slice(0, 4000);
          } catch {
            return String(parsedRequest ?? '').slice(0, 4000);
          }
        })();

        // Focus and type
        try {
          await composerHandle.click({ clickCount: 1 });
          await page.keyboard.type(prompt, { delay: 8 });
        } catch (e) {
          await page.evaluate((el, text) => {
            try {
              if ((el as HTMLElement).isContentEditable) {
                (el as HTMLElement).innerText = text;
              } else if ((el as HTMLTextAreaElement).tagName === 'TEXTAREA' || (el as HTMLInputElement).tagName === 'INPUT') {
                (el as HTMLTextAreaElement).value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                (el as HTMLElement).textContent = text;
              }
            } catch (err) {
              // ignore
            }
          }, composerHandle, prompt);
        }

        // Find and click send
        let sendHandle: any = null;
        for (const sel of sendSelectors) {
          try {
            const h = await page.$(sel);
            if (h && await h.isVisible().catch(() => false)) { sendHandle = h; break; }
          } catch {}
        }
        if (sendHandle) {
          await sendHandle.click();
        } else {
          await page.keyboard.press('Enter');
        }

        // Install MutationObserver in page to push assistant text via exposed function
        await page.evaluate((containerSelectors, assistantSelectors) => {
          try {
            // Helper to get current assistant text
            function currentAssistantText() {
              for (const s of assistantSelectors.concat(containerSelectors)) {
                try {
                  const el = document.querySelector(s);
                  if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
                } catch {}
              }
              const roots = document.querySelectorAll('main, [role="main"], .chat, .chat-history, .chat-container');
              for (const r of Array.from(roots)) {
                const nodes = Array.from(r.querySelectorAll('*')).filter(n => (n.textContent || '').trim().length > 0);
                if (nodes.length) return (nodes[nodes.length - 1].textContent || '').trim();
              }
              return '';
            }

            let last = '';
            let settleTimer: any = null;
            const settleMs = 800; // when no mutations for this ms, consider complete

            function pushIfChanged() {
              try {
                const txt = currentAssistantText();
                if (!txt) return;
                // call back into Node with full text
                (window as any).qwenAdapter_chunk(String(txt));
                if (settleTimer) clearTimeout(settleTimer);
                settleTimer = setTimeout(() => {
                  (window as any).qwenAdapter_complete();
                }, settleMs);
              } catch (e) {
                try { (window as any).qwenAdapter_error(String(e)); } catch {}
              }
            }

            const observer = new MutationObserver((mutations) => {
              pushIfChanged();
            });

            // Observe major containers
            const roots = Array.from(new Set(
              Array.from(document.querySelectorAll(containerSelectors.join(','))).concat(Array.from(document.querySelectorAll('main, [role="main"], .chat, .chat-history, .chat-container')))
            ));
            if (roots.length === 0) {
              // fallback: observe body
              observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            } else {
              for (const r of roots) {
                try { observer.observe(r, { childList: true, subtree: true, characterData: true }); } catch {}
              }
            }

            // Initial push attempt
            pushIfChanged();

            // Expose a stop function
            (window as any).__qwenAdapter_stop = () => {
              try { observer.disconnect(); } catch {}
              if (settleTimer) clearTimeout(settleTimer);
            };
          } catch (e) {
            try { (window as any).qwenAdapter_error(String(e)); } catch {}
          }
        }, messageContainerCandidates, ['[data-role="assistant"]', '.assistant', '.qwen-assistant', '.reply']);

        // Wait until completed or timeout
        const start = Date.now();
        let completed = false;
        while ((Date.now() - start) < MAX_RESPONSE_WAIT_MS) {
          if (abortSignal?.aborted) {
            onEvent({ type: 'error', message: 'Turn aborted' });
            break;
          }
          // Check whether page has set a flag? We'll rely on the qwenAdapter_complete handler
          // which will set completed via event. But we need to detect if browser closed.
          await new Promise(resolve => setTimeout(resolve, 300));
          // Note: completed event will be emitted via page.exposeFunction -> onEvent
          // so we can just continue waiting until timeout or onEvent triggers completed.
          // To avoid blocking forever, break if browser closed
          if (page.isClosed && page.isClosed()) break;
        }

        try { await browser.close(); } catch {}
      } catch (error: any) {
        try { if (browser) await browser.close(); } catch {}
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: 'error', message });
      }
    }
  };
}
