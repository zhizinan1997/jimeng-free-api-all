import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import { markCredentialFailure, markCredentialSuccess, resolveAuthorization } from '@/api/controllers/auth.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
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
                    markCredentialSuccess(credential);
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
