// Playwright-based best-effort Qwen Web adapter (experimental)
// This implementation runs unauthenticated, headless, and uses heuristic selectors.
// It is intended as a prototype only. Improve selectors and integrate with the
// launcher's embedded browser host for production-quality behavior.

import { chromium } from "playwright-core";

export function createQwenWebAdapter(provider: any) {
  return {
    runTurn: async function runTurn(parsedRequest: any, context: { headers?: Headers; abortSignal?: AbortSignal }, onEvent: (e: any) => void) {
      const abortSignal = context?.abortSignal;
      if (abortSignal?.aborted) {
        onEvent({ type: "error", message: "Turn aborted before start" });
        return;
      }

      const url = "https://chat.qwen.ai/";
      let browser: any = null;
      let page: any = null;

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
      ];
      const messageContainerCandidates = [
        '.chat-message',
        '.message',
        '.qwen-chat-item',
        'main',
        '[role="log"]',
        '.chat-history',
      ];

      const timeoutMs = 60_000;

      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        page = await context.newPage();
        // Navigate
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        // Wait a bit for dynamic app to hydrate
        await page.waitForTimeout(1000);

        // Find composer
        let composerHandle: any = null;
        for (const sel of composerSelectors) {
          try {
            composerHandle = await page.$(sel);
            if (composerHandle) break;
          } catch {}
        }

        if (!composerHandle) {
          onEvent({ type: 'error', message: 'Could not find composer element on Qwen page (unauthenticated probe).' });
          await browser.close();
          return;
        }

        // Focus and populate composer. Different element shapes handled.
        const prompt = (parsedRequest && parsedRequest._rawBody && parsedRequest._rawBody.input)
          ? String(parsedRequest._rawBody.input?.map((i: any) => typeof i === 'string' ? i : (i?.text ?? '')).join('\n') || '')
          : (typeof parsedRequest === 'string' ? parsedRequest : JSON.stringify(parsedRequest));

        // Try standard fill
        try {
          await composerHandle.focus();
          // Use keyboard typing to avoid some SPA anti-cheat, but keep it fast
          await page.keyboard.type(prompt, { delay: 5 });
        } catch (e) {
          // Fallback: set innerText/content via JS and dispatch input
          await page.evaluate((el, text) => {
            if (el.isContentEditable) {
              el.innerText = text;
            } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              (el as HTMLTextAreaElement).value = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              el.textContent = text;
            }
            // Dispatch input/change events
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, composerHandle, prompt);
        }

        // Find and click send
        let sendHandle: any = null;
        for (const sel of sendSelectors) {
          try {
            sendHandle = await page.$(sel);
            if (sendHandle) break;
          } catch {}
        }
        if (sendHandle) {
          await sendHandle.click();
        } else {
          // fallback: press Enter
          await page.keyboard.press('Enter');
        }

        // Stream observation: poll for last message text changes from candidate containers
        let lastText = '';
        let stableCount = 0;
        const maxStable = 3; // require several polls of no-change to treat as complete
        const pollInterval = 400;
        const maxWait = 60_000; // max total wait for a response
        let waited = 0;

        while (true) {
          if (abortSignal?.aborted) {
            onEvent({ type: 'error', message: 'Turn aborted' });
            try { await browser.close(); } catch {}
            return;
          }

          // Try to find candidate message text
          const candidateText = await page.evaluate((candidates) => {
            function innerTextOf(el: Element | null) {
              if (!el) return '';
              try { return el.textContent || ''; } catch { return ''; }
            }
            for (const sel of candidates) {
              try {
                const node = document.querySelector(sel);
                if (node && node.textContent && node.textContent.trim()) return node.textContent.trim();
              } catch {}
            }
            // fallback: find last visible text node under any major container
            const roots = document.querySelectorAll('main, [role="main"], .chat, .chat-history, .chat-container');
            for (const r of Array.from(roots)) {
              const texts = Array.from(r.querySelectorAll('*')).map(n => n.textContent || '').filter(t => t.trim());
              if (texts.length) return texts[texts.length - 1].trim();
            }
            return '';
          }, messageContainerCandidates);

          if (candidateText && candidateText !== lastText) {
            // new content observed
            const chunk = candidateText.startsWith(lastText) ? candidateText.slice(lastText.length) : candidateText;
            lastText = candidateText;
            stableCount = 0;
            onEvent({ type: 'response-chunk', text: chunk });
          } else if (!candidateText && !lastText) {
            // not yet started
          } else {
            // no change observed
            stableCount += 1;
          }

          if (stableCount >= maxStable && lastText) {
            onEvent({ type: 'completed' });
            break;
          }

          waited += pollInterval;
          if (waited > maxWait) {
            onEvent({ type: 'error', message: 'Timed out waiting for response' });
            break;
          }
          await page.waitForTimeout(pollInterval);
        }

        try { await browser.close(); } catch {}
      } catch (error: any) {
        try { if (browser) await browser.close(); } catch {}
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: 'error', message });
      }
    },
  };
}
