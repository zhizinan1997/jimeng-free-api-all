import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { generateImagesWithRetry } from "@/api/controllers/images.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.model", v => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", _.isString)
        .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
        .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
        .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("body.filePath", v => _.isUndefined(v) || _.isString(v))
        .validate("headers.authorization", _.isString);
      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);
      const {
        model = "jimeng-image-4.5",
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        sample_strength: sampleStrength,
        response_format,
        filePath: bodyFilePath,
      } = request.body;
      
      // 处理文件上传 (multipart/form-data)
      let filePath = bodyFilePath;
      // @ts-ignore
      const files = request.files || {};
      // 检查是否有上传的文件
      if (!filePath && !_.isEmpty(files)) {
        const fileKey = Object.keys(files)[0];
        const file = files[fileKey];
        if (file) {
            filePath = file.filepath || file.path;
        }
      }

      const responseFormat = _.defaultTo(response_format, "url");
      const imageUrls = await generateImagesWithRetry(model, prompt, {
        ratio,
        resolution,
        sampleStrength,
        negativePrompt,
        filePath,
      }, token);
      
      // 记录统计和媒体
      try {
        db.recordCall(token, model, 0);
        imageUrls.forEach(url => {
          if (url) db.saveMedia('image', url, model, prompt, token);
        });
      } catch (e) {
        // 忽略数据库错误，不影响主流程
      }
      
      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = imageUrls.map((url) => ({
          url,
        }));
      }
      return {
        created: util.unixTimestamp(),
        data,
      };
    },
  },
};
