import Request from '@/lib/request/Request.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { listModelConfigs, toOpenAIModel } from '@/api/controllers/models.ts';

export default {

    prefix: '/v1',

    get: {
        '/models': async (request: Request) => {
            const tokens = typeof request.headers.authorization === 'string'
                ? tokenSplit(request.headers.authorization)
                : [];
            const refresh = request.query.refresh === 'true' || request.query.refresh === '1';
            const type = request.query.type === 'image' || request.query.type === 'video'
                ? request.query.type
                : undefined;
            const models = await listModelConfigs(tokens[0], { refresh, type });

            return {
                data: models.map(toOpenAIModel)
            };
        }

    }
}
