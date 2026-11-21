import type { ServerResponse } from "node:http";

/** Listen to response close, not request close (which also fires after a normal POST upload). */
export function requestDisconnectSignal(response: Pick<ServerResponse, "once" | "removeListener" | "destroyed" | "writableFinished">): AbortSignal {
  const controller = new AbortController();
  const cleanup = () => {
    response.removeListener("close", close);
    response.removeListener("finish", cleanup);
  };
  const close = () => { if (!response.writableFinished) controller.abort(); cleanup(); };
  response.once("close", close);
  response.once("finish", cleanup);
  if (response.destroyed) close();
  return controller.signal;
}
