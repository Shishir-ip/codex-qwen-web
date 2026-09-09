// Adapter scaffold for Qwen Web (chat.qwen.ai)
// This file provides a minimal ProviderAdapter-compatible stub and TODO items.

export function createQwenWebAdapter(provider) {
  return {
    // The upstream adapter exposes runTurn(providerParsed, context, eventCallback)
    // Implement runTurn to: open/attach to a browser tab, insert compiled prompt,
    // attach images, trigger send, observe DOM for incremental chunks, and
    // emit AdapterEvent objects through the provided callback.
    runTurn: async function runTurn(parsedRequest, context, onEvent) {
      // Context: { headers, abortSignal }
      // onEvent({ type: 'response-chunk', text: '...' })
      // onEvent({ type: 'error', message: '...' })
      // onEvent({ type: 'completed' })

      // TODO: Implement the Playwright/Electron interaction adapted to Qwen Web.
      // Steps to implement:
      // 1. Acquire or create an embedded browser tab (the launcher/browser host provides this in upstream).
      // 2. Navigate or reuse Temporary Chat; determine whether to create a new chat or reuse.
      // 3. Insert the compiled Codex prompt into the Qwen composer.
      // 4. Attach images if required (use stable attachment references like upstream does).
      // 5. Trigger the Send action and verify send-readiness.
      // 6. Observe incremental response parts in the DOM; emit `onEvent` for each chunk.
      // 7. Handle completion and any MCP/tool calls if Full mode is enabled.

      onEvent({ type: "error", message: "Qwen adapter not yet implemented. Run tests/qwen-probe.ts to collect selectors and enable implementation." });
      return;
    },
  };
}
