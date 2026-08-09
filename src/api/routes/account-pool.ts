import * as controller from "@/api/controllers/account-pool.ts";

/**
 * Account-pool route definitions. The main thread must add this object to its route list.
 * The selected account's decrypted credential is intentionally not returned by the HTTP handler.
 */
export default {
  prefix: "/account-pool",
  get: {
    "/": controller.list,
    "/select": controller.select,
    "/:id/status": controller.refresh,
    "/:id": controller.get
  },
  post: {
    "/": controller.create,
    "/:id/refresh-status": controller.refresh
  },
  patch: {
    "/:id": controller.update,
    "/:id/enabled": controller.enable
  },
  delete: {
    "/:id": controller.remove
  }
};
