import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import images from "./images.ts";
import chat from "./chat.ts";
import ping from "./ping.ts";
import token from './token.js';
import models from './models.ts';
import videos from './videos.ts';
import dashboard from './dashboard.ts';
import accountPool from './account-pool.ts';
import accountStatus from './account-status.ts';
import { usage } from '../controllers/usage.ts';
import { DEFAULT_MODEL as IMAGE_MODEL } from '../controllers/images.ts';
import { DEFAULT_MODEL as VIDEO_MODEL } from '../controllers/videos.ts';

images.post['/generations'] = usage.wrap(images.post['/generations'], '/v1/images/generations', IMAGE_MODEL);
videos.post['/generations'] = usage.wrap(videos.post['/generations'], '/v1/videos/generations', VIDEO_MODEL);
chat.post['/completions'] = usage.wrap(chat.post['/completions'], '/v1/chat/completions', IMAGE_MODEL);

export default [
    {
        get: {
            '/usage.css': async () => new Response(await fs.readFile('public/usage.css'), { type: 'css' }),
            '/': async () => {
                const content = await fs.readFile('public/index.html');
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            },
            '/favicon.ico': async () => {
                // 返回空的 favicon，避免浏览器请求报错
                return new Response(null, {
                    statusCode: 204,
                    headers: {
                        'Content-Type': 'image/x-icon',
                        'Cache-Control': 'public, max-age=86400'
                    }
                });
            }
        }
    },
    images,
    chat,
    ping,
    token,
    models,
    videos,
    dashboard,
    accountPool,
    accountStatus
];
