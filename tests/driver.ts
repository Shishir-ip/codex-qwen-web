import { createQwenWebAdapter } from "../src/adapters/chatqwen-web.ts";
import { buildLauncherHostAdapter } from "../src/launcher-browser-host-adapter.ts";
import { createMockLauncherHost } from "./mock-launcher-host.ts";
import type { BrowserHost, LauncherDescriptor } from "../src/browser-host.ts";

function descriptorFromEnv(): LauncherDescriptor | undefined {
  const descriptorJson = process.env.QWEN_LAUNCHER_DESCRIPTOR;
  if (descriptorJson) {
    try {
      return JSON.parse(descriptorJson) as LauncherDescriptor;
    } catch (error) {
      throw new Error(`Invalid QWEN_LAUNCHER_DESCRIPTOR JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (process.env.QWEN_LAUNCHER_CONTROL_SOCKET) {
    return { controlSocket: process.env.QWEN_LAUNCHER_CONTROL_SOCKET };
  }

  if (process.env.QWEN_LAUNCHER_URL) {
    return { url: process.env.QWEN_LAUNCHER_URL };
  }

  return undefined;
}

async function buildHost(): Promise<BrowserHost> {
  const forceMock = process.env.QWEN_USE_MOCK_HOST === "1";
  if (!forceMock) {
    const descriptor = descriptorFromEnv();
    if (descriptor) {
      try {
        console.log("Using launcher host adapter from descriptor");
        return buildLauncherHostAdapter(descriptor);
      } catch (error) {
        console.warn(
          `Launcher host adapter unavailable (${error instanceof Error ? error.message : String(error)}), falling back to mock host`,
        );
      }
    }
  }

  console.log("Using Playwright mock launcher host");
  return createMockLauncherHost({
    headful: Boolean(process.env.QWEN_HEADFUL && process.env.QWEN_HEADFUL !== "0"),
  });
}

async function run() {
  const host = await buildHost();
  const adapter = createQwenWebAdapter({ browserHost: host });
  console.log("Starting Qwen adapter driver (headful if QWEN_HEADFUL=1)");

  await adapter.runTurn(
    { _rawBody: { input: ["Hello from codex-qwen-web driver. Please reply with a short greeting."] } },
    { abortSignal: undefined },
    (event) => {
      if (event.type === "response-chunk") {
        process.stdout.write(event.text);
      } else if (event.type === "completed") {
        process.stdout.write("\n---completed---\n");
      } else if (event.type === "error") {
        console.error("\nADAPTER ERROR:", event.message);
      } else {
        console.log("EVENT:", event);
      }
    },
  );
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
