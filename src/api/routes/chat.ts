import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            if (tokens.length === 0) {
                throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Authorization token is empty");
            }
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);
            const { model, messages, stream } = request.body;
            if (stream) {
                const stream = await createCompletionStream(messages, token, model);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await createCompletion(messages, token, model);
        }

    }

}
