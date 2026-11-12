import { CancelRegistry } from "./cancel.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PoolManager } from "./pool.js";
import { RouteStore } from "./routes.js";
import { SessionServer } from "./session.js";
import { TransactionServer } from "./transaction.js";

const VERSION = process.env.JP_VERSION || "0.0.0-dev";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info({ version: VERSION, sqlite: config.sqlitePath }, "justpostgres router starting");

  const store = new RouteStore(config, logger.child({ component: "routes" }));
  store.start();
  logger.info({ routes: store.size() }, "routing table loaded");

  const cancels = new CancelRegistry();

  const session = new SessionServer(config, store, cancels, logger.child({ component: "session" }));
  await session.listen();
  logger.info(
    {
      port: config.sessionPort,
      tls: config.tls !== null,
      sni: config.domainSuffix ?? null,
    },
    "session mode listening",
  );

  const pools = new PoolManager(config, logger.child({ component: "pool" }));
  pools.start();

  const pooled = new TransactionServer(config, store, pools, logger.child({ component: "pool" }));
  await pooled.listen();
  logger.info(
    { port: config.poolPort, poolSize: config.pool.size, resetQuery: config.pool.resetQuery || null },
    "transaction pooling listening",
  );

  if (!config.tls) {
    logger.warn(
      "No TLS configured: SNI routing is unavailable and connections are in cleartext. " +
        "Clients must use the username form <role>.<project-ref>.",
    );
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await Promise.all([session.close(), pooled.close()]);
    pools.stop();
    store.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  setInterval(() => {
    logger.debug(
      {
        session: session.getStats(),
        pooled: pooled.getStats(),
        pools: pools.stats(),
        routes: store.status(),
      },
      "router stats",
    );
  }, 60_000).unref();
}

main().catch((err) => {
  console.error(`\njustpostgres router failed to start:\n\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
