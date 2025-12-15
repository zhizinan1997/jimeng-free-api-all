import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import images from "./images.ts";
import chat from "./chat.ts";
import ping from "./ping.ts";
import token from './token.js';
import models from './models.ts';
import videos from './videos.ts';
import dashboard from './dashboard.ts';

export default [
    {
        get: {
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
    dashboard
];