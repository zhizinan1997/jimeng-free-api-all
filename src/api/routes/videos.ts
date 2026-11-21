import { recoverPoolTask } from "../../lib/pool-task-recovery.ts";
import { poolTaskErrorPayload, withPoolRoutes } from "../../lib/pool-task-routes.ts";
import { currentPoolTask, failPoolTask } from "../../lib/pool-task-context.ts";
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import FailureBody from '@/lib/response/FailureBody.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import { jsonHeartbeatResponse } from '@/lib/json-heartbeat.ts';
import { generateVideoWithRetry, DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import { markCredentialFailure, markCredentialSuccess, resolveAuthorization } from '@/api/controllers/auth.ts';
import util from '@/lib/util.ts';
import db from '@/lib/database.ts';

function appendUploadedPaths(value: any, target: string[]) {
    if (!value) return;
    if (Array.isArray(value)) {
        value.forEach(item => appendUploadedPaths(item, target));
        return;
    }
    const path = value.filepath || value.path;
    if (typeof path === 'string' && path) target.push(path);
}

const routes = {

    prefix: '/v1/videos',

  get: { "/tasks/:taskId": request => recoverPoolTask(request, "video") },
    post: {

        '/generations': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => _.isUndefined(v) || _.isInteger(v))
                .validate('body.file_paths', v => _.isUndefined(v) || (_.isArray(v) && v.every(_.isString)))
                .validate('body.video_paths', v => _.isUndefined(v) || (_.isArray(v) && v.every(_.isString)))
                .validate('body.audio_paths', v => _.isUndefined(v) || (_.isArray(v) && v.every(_.isString)))
                .validate('body.function_mode', v => _.isUndefined(v) || v === 'omni_reference')
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            // refresh_token切分
            // 随机挑选一个refresh_token
            const credential = await resolveAuthorization(request.headers.authorization);
            const token = credential.token;
            const statsKey = credential.managedKey || token;

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration,
                file_paths = [],
                video_paths = [],
                audio_paths = [],
                function_mode,
                response_format = "url"
            } = request.body;

            // 处理文件上传
            let filePaths = [...file_paths];
            const files: Record<string, any> = request.files || {};
            if (!_.isEmpty(files)) {
                Object.values(files).forEach(file => appendUploadedPaths(file, filePaths));
            }
            if (function_mode === 'omni_reference') {
                if (!['jimeng-video-seedance-2.5', 'jimeng-video-seedance-2.0', 'jimeng-video-seedance-2.0-fast', 'jimeng-video-seedance-2.0-vip', 'jimeng-video-seedance-2.0-fast-vip'].includes(model)) {
                    throw new Error('当前模型不支持全能参考');
                }
                if (model === 'jimeng-video-seedance-2.5' && (duration === undefined || duration < 5 || duration > 30 || (resolution ?? '720p') !== '720p' || video_paths.length || audio_paths.length)) {
                    throw new Error('Seedance 2.5 全能参考目前仅适配 720p、5 至 30 秒图片参考');
                }
                if (filePaths.length > 9 || video_paths.length > 3 || audio_paths.length > 3 ||
                    filePaths.length + video_paths.length + audio_paths.length < 1) {
                    throw new Error('全能参考需至少一份素材，最多 9 张图片、3 个视频和 3 个音频');
                }
            } else if (model === 'jimeng-video-seedance-2.5' && duration !== undefined && ![5, 10].includes(duration)) {
                throw new Error('Seedance 2.5 此时长当前仅适配全能参考图片模式');
            } else if (filePaths.length > 2) {
                throw new Error('首尾帧模式最多支持两张图片');
            } else if (video_paths.length || audio_paths.length) {
                throw new Error('视频或音频参考素材仅支持全能参考模式');
            }

            const poolContext = currentPoolTask();
            const poolFields = () => poolContext?.taskId
                ? {
                    pool_task_id: poolContext.taskId,
                    request_id: poolContext.requestId,
                    ...(poolContext.settlementPending ? { settlement_pending: true } : {}),
                }
                : {};

            // Short requests keep ordinary JSON; long generations send JSON whitespace
            // until the same single result document is ready (including b64 conversion).
            return jsonHeartbeatResponse(async () => {
                // 生成视频
                let videoUrl;
                try {
                    videoUrl = await generateVideoWithRetry(
                        model,
                        prompt,
                        {
                            ratio,
                            resolution,
                            duration,
                            filePaths,
                            videoPaths: video_paths,
                            audioPaths: audio_paths,
                            functionMode: function_mode
                        },
                        token,
                        credential.cookie
                    );
                    if (typeof videoUrl !== 'string' || !videoUrl.trim()) {
                        throw new APIException(EX.API_VIDEO_GENERATION_FAILED, '视频生成未返回有效结果');
                    }
                    markCredentialSuccess(credential);
                } catch (error) {
                    markCredentialFailure(credential);
                    await failPoolTask();
                    throw error;
                }

                // 记录统计和媒体
                try {
                    db.recordCall(statsKey, model, 0);
                    if (videoUrl) db.saveMedia('video', videoUrl, model, prompt, statsKey);
                } catch (e) {
                    // 忽略数据库错误
                }

                // 根据response_format返回不同格式的结果
                if (response_format === "b64_json") {
                    try {
                        const videoBase64 = await util.fetchFileBASE64(videoUrl);
                        return {
                            created: util.unixTimestamp(),
                            data: [{
                                b64_json: videoBase64,
                                revised_prompt: prompt
                            }],
                            ...poolFields(),
                        };
                    } catch (error) {
                        await failPoolTask();
                        throw error;
                    }
                } else {
                    return {
                        created: util.unixTimestamp(),
                        data: [{
                            url: videoUrl,
                            revised_prompt: prompt
                        }],
                        ...poolFields(),
                    };
                }
            }, undefined, {
                errorBody: (error) => {
                    const sanitized = poolTaskErrorPayload(error, poolContext);
                    return sanitized ? sanitized.body : new FailureBody(error as any).toObject();
                },
            });
        }

    }

}

export default withPoolRoutes(routes, "video", DEFAULT_MODEL);
