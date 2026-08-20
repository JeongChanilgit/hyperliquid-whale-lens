import { loadCopyRunnerConfig } from "./config";
import { StandaloneCopyRunner } from "./runner";

const main = async (): Promise<void> => {
  const runner = new StandaloneCopyRunner(loadCopyRunnerConfig());
  await runner.start();
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log("[copy-runner] shutting down");
    await runner.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
};

void main().catch((error) => {
  console.error("[copy-runner] fatal", error);
  process.exitCode = 1;
});
