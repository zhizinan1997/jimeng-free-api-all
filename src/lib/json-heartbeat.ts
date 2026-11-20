import { PassThrough } from 'node:stream';

import Response from './response/Response.ts';
import FailureBody from './response/FailureBody.ts';
import logger from './logger.ts';

/** Keep long JSON responses active without changing their final JSON document. */
export async function jsonHeartbeatResponse<T>(
    operation: () => Promise<T>,
    intervalMs = 15_000,
    options: { errorBody?: (error: unknown) => unknown } = {},
): Promise<T | Response> {
    const startedAt = Date.now();
    // Capture both outcomes immediately, including after the client disconnects.
    const completion = Promise.resolve().then(operation).then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
    );
    let delay: ReturnType<typeof setTimeout>;
    const first = await Promise.race([
        completion,
        new Promise<null>(resolve => { delay = setTimeout(() => resolve(null), intervalMs); }),
    ]);
    clearTimeout(delay);
    // Fast requests keep the existing body and HTTP error handling unchanged.
    if (first !== null) {
        if (first.ok === false) throw first.error;
        return first.value;
    }

    const stream = new PassThrough();
    const writable = () => !stream.destroyed && !stream.writableEnded;
    const heartbeat = () => {
        // A stalled reader must not cause an unbounded timer-driven write queue.
        if (writable() && !stream.writableNeedDrain) stream.write('\n');
    };
    const interval = setInterval(heartbeat, intervalMs);
    const cleanup = () => { clearInterval(interval); };
    stream.once('close', () => {
        cleanup();
        if (!stream.writableFinished) logger.info(`JSON response disconnected after ${Date.now() - startedAt}ms; original operation retained`);
    });
    stream.once('finish', cleanup);
    stream.once('error', cleanup);
    heartbeat();

    void completion.then(result => {
        cleanup();
        logger.info(`JSON operation completed after ${Date.now() - startedAt}ms; outcome=${result.ok ? 'success' : 'failure'}; consumer_closed=${!writable()}`);
        if (!result.ok) logger.error('JSON operation failed; see the bound task status');
        // Losing the HTTP consumer must not cancel or resubmit paid generation.
        if (!writable()) return;
        let body: string;
        try {
            body = JSON.stringify(result.ok === true ? result.value : options.errorBody
                ? options.errorBody(result.error) : new FailureBody(result.error).toObject());
        } catch (error) {
            logger.error('JSON response serialization failed');
            body = JSON.stringify(new FailureBody(new Error('Response serialization failed')).toObject());
        }
        stream.end(body);
    });

    return new Response(stream, {
        statusCode: 200,
        type: 'application/json',
        headers: {
            'Cache-Control': 'no-cache, no-store, no-transform',
            'X-Accel-Buffering': 'no',
        },
        flushHeaders: true,
    });
}
