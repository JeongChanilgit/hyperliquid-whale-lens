import { loadFaithfulMirrorConfig } from "./config.mjs";
import { FaithfulMirrorV2Service } from "./service.mjs";

const config = loadFaithfulMirrorConfig(process.env);
const service = new FaithfulMirrorV2Service({ config, env: process.env });

const shutdown = async (signal) => {
  console.log(`[fmv2] ${signal}; shutting down`);
  try { await service.close(); }
  finally { process.exit(0); }
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("uncaughtException", (error) => {
  console.error("[fmv2] uncaught exception", error);
  void service.stop({ emergency: true, reason: "UNCAUGHT_EXCEPTION" }).finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  console.error("[fmv2] unhandled rejection", error);
  void service.stop({ emergency: true, reason: "UNHANDLED_REJECTION" }).finally(() => process.exit(1));
});

await service.initialize();
console.log(`[fmv2] control listening on http://${config.controlHost}:${config.controlPort}; mode=${config.mode}; pairs=${config.pairs.length}`);
