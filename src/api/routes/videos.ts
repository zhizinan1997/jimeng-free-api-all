import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { generateVideoWithRetry, DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import util from '@/lib/util.ts';
import db from '@/lib/database.ts';

export default {

    prefix: '/v1/videos',

    post: {

        '/generations': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => _.isUndefined(v) || _.isFinite(v))
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration = 10,
                file_paths = [],
                response_format = "url"
            } = request.body;

            // 处理文件上传
            let filePaths = [...file_paths];
            // @ts-ignore
            const files = request.files || {};
            if (!_.isEmpty(files)) {
                _.forEach(files, (file) => {
                    if (file) {
                        const path = file.filepath || file.path;
                        if (path) filePaths.push(path);
                    }
                });
            }

            // 生成视频
            const videoUrl = await generateVideoWithRetry(
                model,
                prompt,
                {
                    ratio,
                    resolution,
                    duration,
                    filePaths
                },
                token
            );

            // 记录统计和媒体
            try {
                db.recordCall(token, model, 0);
                if (videoUrl) db.saveMedia('video', videoUrl, model, prompt, token);
            } catch (e) {
                // 忽略数据库错误
            }

            // 根据response_format返回不同格式的结果
            if (response_format === "b64_json") {
                const videoBase64 = await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            } else {
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        url: videoUrl,
                        revised_prompt: prompt
                    }]
                };
            }
        }

    }

}