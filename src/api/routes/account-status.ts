import Request from "@/lib/request/Request.ts";

import { resolveAuthorization } from "@/api/controllers/auth.ts";
import { getCredit } from "@/api/controllers/core.ts";
import accountPool from "@/lib/account-pool.ts";

export default {
  prefix: "/v1/account",
  get: {
    "/status": async (request: Request) => {
      request.validate("headers.authorization", (value) => typeof value === "string");
      const credential = await resolveAuthorization(request.headers.authorization);
      if (credential.accountId) {
        const cached = accountPool.getDashboard().accounts.find(account => account.id === credential.accountId);
        const refreshPending = cached.scheduling.activeTaskCount > 0;
        const account = refreshPending ? cached : await accountPool.refreshStatus(credential.accountId);
        return {
          account: {
            id: account.id,
            name: account.name,
            enabled: account.enabled,
            status: account.status,
            refresh_pending: refreshPending,
          },
        };
      }
      const credits = await getCredit(credential.token, credential.cookie);
      return { account: { status: { ...credits, membership: "unknown" } } };
    },
  },
};
