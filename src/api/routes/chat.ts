import { recoverPoolTask } from "../../lib/pool-task-recovery.ts";
import { withPoolRoutes } from "../../lib/pool-task-routes.ts";
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import { PoolTaskReplay, markCredentialFailure, markCredentialSuccess, resolveAuthorization } from '@/api/controllers/auth.ts';
import { createAgentTextCompletion } from '@/api/controllers/text-chat.ts';
import { isAgentTextModel, normalizeTextChatRequest, textChatCompatibilityHeaders } from '@/lib/text-chat-request.ts';
import { publicTextChatError } from '@/lib/text-chat-completion.ts';

const routes = {

    prefix: '/v1/chat',

  get: { "/tasks/:taskId": request => recoverPoolTask(request) },
    post: {

        '/completions': async (request: Request) => {
            if (isAgentTextModel(request.body?.model)) {
                try {
                    // Validate before selecting an account or opening any upstream request.
                    const input = normalizeTextChatRequest(request.body);
                    if (typeof request.headers.authorization !== 'string' || !request.headers.authorization.trim()) {
                        return new Response({ error: { message: '缺少 Authorization 凭据', type: 'authentication_error', code: 'invalid_api_key' } }, { statusCode: 401 });
                    }
                    let credential;
                    try {
                        credential = await resolveAuthorization(request.headers.authorization);
                    } catch (error) {
                        if (error instanceof PoolTaskReplay || error?.name === "PoolError") throw error;
                        return new Response({ error: { message: '凭据无效或账号池暂无可用账号', type: 'authentication_error', code: 'credential_unavailable' } }, { statusCode: 401 });
                    }
                    const result = await createAgentTextCompletion(input, credential, request.signal);
                    return input.stream ? new Response(result, {
                        type: 'text/event-stream; charset=utf-8',
                        headers: { 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', ...textChatCompatibilityHeaders(input) },
                    }) : new Response(result, { headers: textChatCompatibilityHeaders(input) });
                } catch (error) {
                    if (error instanceof PoolTaskReplay || error?.name === "PoolError") throw error;
                    const failure = publicTextChatError(error);
                    return new Response({ error: failure.error }, { statusCode: failure.status });
                }
            }
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            // refresh_token切分
            // 随机挑选一个refresh_token
            const credential = await resolveAuthorization(request.headers.authorization);
            const token = credential.token;
            const { model, messages, stream } = request.body;
            try {
                if (stream) {
                    const stream = await createCompletionStream(messages, token, model);
                    return new Response(stream, {
                        type: "text/event-stream"
                    });
                }
                const result = await createCompletion(messages, token, model);
                markCredentialSuccess(credential);
                return result;
            } catch (error) {
                markCredentialFailure(credential);
                throw error;
            }
        }

    }

}

export default withPoolRoutes(routes, request => isAgentTextModel(request.body?.model) ? "text" : request.body?.model?.includes("video") ? "video" : "image", "jimeng-image-5.0-lite");
