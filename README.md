# codex-qwen-web

A fork-style scaffold of miuuyy/codex-chatgpt-web adapted to add a Qwen Web adapter (chat.qwen.ai).

Goal
- Let Codex run Qwen Web chats as routed/native Codex models by automating an authenticated browser session, streaming responses back into the Responses protocol, and (optionally) wiring MCP tool calls.

This repository is an initial scaffold for exploration and development. It mirrors the upstream layout and provides a stub adapter and a Playwright probe to collect DOM selectors for automation.

Security & policy
- This project automates a web UI. Verify the target site's terms of service before proceeding.
- Do not store secrets in the repository. Use ephemeral storage-state files or local runtime keys for testing.

What is included in this branch
- README.md (this file)
- package.json (minimal, adjusted metadata)
- launcher/package.json (adjusted metadata for the launcher)
- src/adapters/chatqwen-web.ts — adapter scaffold and TODOs
- tests/qwen-probe.ts — Playwright probe script to run locally to discover selectors and verify automation

Next steps
1. Run tests/qwen-probe.ts locally with a Playwright-capable environment to discover Qwen DOM selectors.
2. Implement runTurn in src/adapters/chatqwen-web.ts using the discovered selectors and the same runTurn contract as the upstream chatgpt-web adapter.
3. Add model-catalog entries, token accounting, and optional MCP/tunnel integration.

License: MIT
