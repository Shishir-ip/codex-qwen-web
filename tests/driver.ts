import { createQwenWebAdapter } from "../src/adapters/chatqwen-web";

async function run() {
  const adapter = createQwenWebAdapter({});
  console.log("Starting Qwen adapter driver (headful if QWEN_HEADFUL=1)");
  await adapter.runTurn(
    { _rawBody: { input: ["Hello from codex-qwen-web driver. Please reply with a short greeting."] } },
    { abortSignal: undefined },
    (event) => {
      if (event.type === 'response-chunk') {
        process.stdout.write(event.text);
      } else if (event.type === 'completed') {
        process.stdout.write('\n---completed---\n');
      } else if (event.type === 'error') {
        console.error('\nADAPTER ERROR:', event.message);
      } else {
        console.log('EVENT:', event);
      }
    },
  );
}

run().catch(err => { console.error(err); process.exitCode = 1; });
