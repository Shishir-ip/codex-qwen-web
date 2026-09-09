# codex-qwen-web

A scaffold of `miuuyy/codex-chatgpt-web` adapted for an unauthenticated Qwen Web (`https://chat.qwen.ai/`) adapter.

## Security and scope

- Do not store secrets in this repository.
- The adapter wiring in this branch does **not** sign in automatically.
- For authenticated testing, provide a signed-in launcher/browser profile externally.

## BrowserHost contract

The Qwen adapter uses a `BrowserHost` abstraction (`/src/browser-host.ts`):

- `openTab(url: string): Promise<{ tabId: string }>`
- `runInTab(tabId, { action: "fillAndSend", prompt })`
- `observeTab(tabId, handlers): () => void`
- `closeTab(tabId)`
- `onceTabComplete(tabId, cb)`

`LauncherDescriptor` shape:

- `controlSocket?: string` (UNIX domain socket for JSON-RPC control)
- `url?: string` (HTTP control server)
- optional: `rpcPath`, `eventsPath`, `token`, `headers`, `timeoutMs`, `reconnectAttempts`

## Launcher integration

`src/launcher-browser-host-adapter.ts` implements `buildLauncherHostAdapter(descriptor)` with two modes:

1. `controlSocket`: JSON-RPC over UNIX socket (`openTab`, `runInTab`, `observeTab`, `closeTab`)
2. `url`: HTTP control endpoints + SSE tab event streaming

Streaming events are forwarded as response chunks/completion/error and include reconnect + timeout handling.

## Local development (mock host)

A Playwright mock BrowserHost lives at `tests/mock-launcher-host.ts`. It opens a real browser page, fills/sends prompts, and streams mutations.

Driver behavior (`tests/driver.ts`):

1. If launcher descriptor is provided, it uses the launcher adapter.
2. Otherwise it falls back to the mock BrowserHost.

Launcher descriptor env options:

- `QWEN_LAUNCHER_DESCRIPTOR='{"url":"http://127.0.0.1:3000"}'`
- `QWEN_LAUNCHER_CONTROL_SOCKET=/path/to/launcher.sock`
- `QWEN_LAUNCHER_URL=http://127.0.0.1:3000`

Set `QWEN_HEADFUL=1` to keep browser windows visible in local runs.

## Commands

```bash
npm install
npx playwright install
```

Probe selectors (headful):

```bash
node tests/qwen-probe.ts
```

Run adapter driver:

```bash
QWEN_HEADFUL=1 bun run tests/driver.ts
```

Run local smoke wiring test (mock host + driver, exits non-zero on failure):

```bash
npm run smoke:host
```

## TODOs

- Validate against the real launcher endpoint contract and event schema.
- Perform authenticated end-to-end testing with a signed-in launcher profile.
