"use strict";

import environment from "@/lib/environment.ts";
import config from "@/lib/config.ts";
import "@/lib/initialize.ts";
import server from "@/lib/server.ts";
import routes from "@/api/routes/index.ts";
import logger from "@/lib/logger.ts";
import accountPool from "@/lib/account-pool.ts";
import { createPoolMaintenance } from "@/lib/pool-maintenance.ts";
import { recoverStoredPoolTask } from "@/lib/pool-task-recovery.ts";

const startupTime = performance.now();

(async () => {
  logger.header();

  logger.info("<<<< jimeng free server >>>>");
  logger.info("Version:", environment.package.version);
  logger.info("Process id:", process.pid);
  logger.info("Environment:", environment.env);
  logger.info("Service name:", config.service.name);

  server.attachRoutes(routes);
  await server.listen();

  const poolMaintenance = createPoolMaintenance({
    listRecoverableTasks: () => accountPool.scanTasksForMaintenance(),
    recoverTask: recoverStoredPoolTask,
    settleTask: async (id) => { await accountPool.settleTask(id); },
    refreshStaleAccounts: async () => { await accountPool.refreshStaleAccounts(); },
    report: ({ phase, taskId }) => logger.warn(`Account pool maintenance ${phase} deferred${taskId ? ` (${taskId})` : ''}`),
  });
  poolMaintenance.start();
  process.once('exit', () => poolMaintenance.stop());

  config.service.bindAddress &&
    logger.success("Service bind address:", config.service.bindAddress);
})()
  .then(() =>
    logger.success(
      `Service startup completed (${Math.floor(performance.now() - startupTime)}ms)`
    )
  )
  .catch((err) => console.error(err));
