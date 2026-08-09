import Request from '@/lib/request/Request.ts';
import { resolveAuthorization } from '@/api/controllers/auth.ts';
import { listModelConfigs, toOpenAIModel } from '@/api/controllers/models.ts';

export default {

    prefix: '/v1',

    get: {
        '/models': async (request: Request) => {
            const credential = typeof request.headers.authorization === 'string'
                ? await resolveAuthorization(request.headers.authorization)
                : undefined;
            const refresh = request.query.refresh === 'true' || request.query.refresh === '1';
            const type = request.query.type === 'image' || request.query.type === 'video'
                ? request.query.type
                : undefined;
            const models = await listModelConfigs(credential?.token, { refresh, type });

            return {
                data: models.map(toOpenAIModel)
            };
        }

    }
}
