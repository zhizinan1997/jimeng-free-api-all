import Request from "@/lib/request/Request.ts";

import { markCredentialFailure, markCredentialSuccess, resolveAuthorization } from "@/api/controllers/auth.ts";
import { getCredit } from "@/api/controllers/core.ts";
import accountPool from "@/lib/account-pool.ts";

export default {
  prefix: "/v1/account",
  get: {
    "/status": async (request: Request) => {
      request.validate("headers.authorization", (value) => typeof value === "string");
      const credential = await resolveAuthorization(request.headers.authorization);
      try {
        if (credential.accountId) {
          const account = await accountPool.refreshStatus(credential.accountId);
          markCredentialSuccess(credential);
          return {
            account: {
              id: account.id,
              name: account.name,
              enabled: account.enabled,
              status: account.status,
            },
          };
        }

        const credits = await getCredit(credential.token);
        markCredentialSuccess(credential);
        return { account: { status: { ...credits, membership: "unknown" } } };
      } catch (error) {
        markCredentialFailure(credential);
        throw error;
      }
    },
  },
};
