import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "jimeng-image-4.5",
                        "object": "model",
                        "owned_by": "jimeng-image",
                        "description": "即梦AI图片生成模型 4.5 版本（最新）"
                    },
                    {
                        "id": "jimeng-image-4.1",
                        "object": "model",
                        "owned_by": "jimeng-image",
                        "description": "即梦AI图片生成模型 4.1 版本"
                    },
                    {
                        "id": "jimeng-image-4.0",
                        "object": "model",
                        "owned_by": "jimeng-image",
                        "description": "即梦AI图片生成模型 4.0 版本"
                    },
                    {
                        "id": "jimeng-image-3.1",
                        "object": "model",
                        "owned_by": "jimeng-image",
                        "description": "即梦AI图片生成模型 3.1 版本"
                    },
                    {
                        "id": "jimeng-image-3.0",
                        "object": "model",
                        "owned_by": "jimeng-image",
                        "description": "即梦AI图片生成模型 3.0 版本"
                    },
                    {
                        "id": "jimeng-video-3.0",
                        "object": "model",
                        "owned_by": "jimeng-video",
                        "description": "即梦AI视频生成模型 3.0 版本"
                    },
                    {
                        "id": "jimeng-video-3.0-pro",
                        "object": "model",
                        "owned_by": "jimeng-video",
                        "description": "即梦AI视频生成模型 3.0 专业版"
                    },
                    {
                        "id": "jimeng-video-3.0-fast",
                        "object": "model",
                        "owned_by": "jimeng-video",
                        "description": "即梦AI视频生成模型 3.0 快速版"
                    },
                    {
                        "id": "jimeng-video-s2.0",
                        "object": "model",
                        "owned_by": "jimeng-video",
                        "description": "即梦AI视频生成模型 S2.0 (轻量版)"
                    },
                    {
                        "id": "jimeng-video-2.0-pro",
                        "object": "model",
                        "owned_by": "jimeng-video",
                        "description": "即梦AI视频生成模型 2.0 专业版"
                    }
                ]
            };
        }

    }
}