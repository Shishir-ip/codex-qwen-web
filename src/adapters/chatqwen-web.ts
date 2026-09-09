// Improved Playwright-based unauthenticated Qwen Web adapter prototype
// - Uses heuristic selectors but adds more robust discovery, retries, and configurable headful mode.
// - Streams incremental text by polling the last assistant message with stricter heuristics.
// - Intended for local development only. Integrate with launcher/browser-host for production.

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
      const MAX_COMPOSER_WAIT_MS = Number(process.env.QWEN_COMPOSER_WAIT_MS ?? 15000);
      const MAX_RESPONSE_WAIT_MS = Number(process.env.QWEN_RESPONSE_WAIT_MS ?? 90000);

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

        // Wait briefly for SPA hydration
        await page.waitForTimeout(800);

        // Try to discover the composer element with a short loop
        let composerHandle: any = null;
        const composerStart = Date.now();
        while (!composerHandle && (Date.now() - composerStart) < MAX_COMPOSER_WAIT_MS) {
          for (const sel of composerSelectors) {
            try {
              const h = await page.$(sel);
              if (h) {
                // Heuristic: ensure it's visible and editable
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
          await browser.close();
          return;
        }

        // Build prompt text from parsedRequest as a best-effort
        const prompt = (() => {
          if (parsedRequest && typeof parsedRequest === 'object') {
            try {
              const raw = parsedRequest._rawBody ?? parsedRequest;
              if (raw && Array.isArray(raw.input)) return raw.input.map(i => (typeof i === 'string' ? i : i?.text ?? '')).join('\n');
              if (typeof parsedRequest === 'string') return parsedRequest;
              const maybe = parsedRequest.input ?? parsedRequest.message ?? parsedRequest.prompt;
              if (typeof maybe === 'string') return maybe;
            } catch {}
            return JSON.stringify(parsedRequest).slice(0, 4000);
          }
          return String(parsedRequest ?? '').slice(0, 4000);
        })();

        // Focus and type into composer. Use typing with a small delay to mimic human input.
        try {
          await composerHandle.click({ clickCount: 1 });
          await page.keyboard.type(prompt, { delay: 8 });
        } catch (e) {
          // Fallback: write into the element via JS and dispatch events
          await page.evaluate((el, text) => {
            if ((el as HTMLElement).isContentEditable) {
              (el as HTMLElement).innerText = text;
            } else if ((el as HTMLTextAreaElement).tagName === 'TEXTAREA' || (el as HTMLInputElement).tagName === 'INPUT') {
              (el as HTMLTextAreaElement).value = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              (el as HTMLElement).textContent = text;
            }
          }, composerHandle, prompt);
        }

        // Find and activate send
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
          // fallback: press Enter
          await page.keyboard.press('Enter');
        }

        // Streaming: poll for the last assistant message text. Use stricter candidates and stable-check logic.
        let lastText = '';
        let unchangedIterations = 0;
        const stableThreshold = 3;
        const pollInterval = 350;
        let elapsed = 0;

        while (elapsed < MAX_RESPONSE_WAIT_MS) {
          if (abortSignal?.aborted) {
            onEvent({ type: 'error', message: 'Turn aborted' });
            await browser.close();
            return;
          }

          const candidateText: string = await page.evaluate((candidates) => {
            // Prefer explicit assistant message markers if present
            const assistantSelectors = [
              '[data-role="assistant"]',
              '.assistant',
              '.qwen-assistant',
              '.reply',
            ];
            try {
              for (const s of assistantSelectors.concat(candidates)) {
                const el = document.querySelector(s);
                if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
              }
              // fallback: find the last large text node in main containers
              const roots = document.querySelectorAll('main, [role="main"], .chat, .chat-history, .chat-container');
              for (const r of Array.from(roots)) {
                const nodes = Array.from(r.querySelectorAll('*')).filter(n => (n.textContent || '').trim().length > 20);
                if (nodes.length) return (nodes[nodes.length - 1].textContent || '').trim();
              }
            } catch (e) {}
            return '';
          }, messageContainerCandidates).catch(() => '');

          if (candidateText && candidateText !== lastText) {
            const chunk = candidateText.startsWith(lastText) ? candidateText.slice(lastText.length) : candidateText;
            lastText = candidateText;
            unchangedIterations = 0;
            onEvent({ type: 'response-chunk', text: chunk });
          } else {
            unchangedIterations += 1;
            if (unchangedIterations >= stableThreshold && lastText) {
              onEvent({ type: 'completed' });
              break;
            }
          }

          await page.waitForTimeout(pollInterval);
          elapsed += pollInterval;
        }

        if (elapsed >= MAX_RESPONSE_WAIT_MS) {
          onEvent({ type: 'error', message: 'Timed out waiting for response' });
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
