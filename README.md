# codex-qwen-web

A fork-style scaffold of miuuyy/codex-chatgpt-web adapted to add a Qwen Web adapter (chat.qwen.ai).

Goal
- Let Codex run Qwen Web chats as routed/native Codex models by automating an authenticated browser session, streaming responses back into the Responses protocol, and (optionally) wiring MCP tool calls.

This repository is an initial scaffold for exploration and development. It mirrors the upstream layout and provides a prototype adapter and a Playwright probe to collect DOM selectors for automation.

Security & policy
- This project automates a web UI. Verify the target site's terms of service before proceeding.
- Do not store secrets in the repository. Use ephemeral storage-state files or local runtime keys for testing.

What is included in this branch
- README.md (this file)
- package.json (minimal, adjusted metadata)
- launcher/package.json (adjusted metadata for the launcher)
- src/adapters/chatqwen-web.ts — adapter prototype (unauthenticated, heuristic selectors)
- tests/qwen-probe.ts — Playwright probe script to run locally to discover selectors and verify automation

How to run the probe locally

1. Clone and install dependencies:

   git clone https://github.com/Shishir-ip/codex-qwen-web
   cd codex-qwen-web
   npm install
   npx playwright install

2. Run the headful probe to inspect the UI and save a screenshot:

   node tests/qwen-probe.ts

3. Inspect tests/qwen-screenshot.png and the console output to refine selectors. For authenticated flows, run the probe in a session that is already signed in.

Run the adapter prototype (unauthenticated, headless by default)

The adapter is a Playwright-based prototype that runs unauthenticated. It is not integrated into the launcher runtime and is only useful for development and selector discovery.

You can exercise it by writing a small driver that imports the adapter and calls runTurn with a short prompt. Example (node + ts-node / bun):

- Set QWEN_HEADFUL=1 to see the browser during runs.

Security & policy reminder
- Automating a web UI may trigger anti-bot measures and may be restricted by the provider’s terms. Ensure you have the right to automate your account before proceeding.
