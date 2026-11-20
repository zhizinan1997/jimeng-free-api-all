import { recoverPoolTask } from "../../lib/pool-task-recovery.ts";
import { withPoolRoutes } from "../../lib/pool-task-routes.ts";
import _ from "lodash";
import { DEFAULT_IMAGE_COUNT } from "../../lib/image-results.ts";

import Request from "@/lib/request/Request.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { DEFAULT_MODEL, generateImagesWithRetry } from "@/api/controllers/images.ts";
import { markCredentialFailure, markCredentialSuccess, resolveAuthorization } from "@/api/controllers/auth.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";

const MAX_REFERENCE_IMAGES = 10;

function appendReferenceImagePaths(value: any, target: string[]) {
  if (_.isString(value)) {
    const filePath = value.trim();
    if (filePath) target.push(filePath);
    return;
  }

  if (_.isArray(value)) {
    value.forEach((item) => appendReferenceImagePaths(item, target));
    return;
  }

  const filePath = value?.filepath || value?.path;
  if (_.isString(filePath) && filePath.trim()) {
    target.push(filePath.trim());
  }
}

function collectReferenceImagePaths(bodyFilePath: any, bodyFilePaths: any, files: any) {
  const paths: string[] = [];
  appendReferenceImagePaths(bodyFilePath, paths);
  appendReferenceImagePaths(bodyFilePaths, paths);
  Object.values(files || {}).forEach((file) => appendReferenceImagePaths(file, paths));
  return _.uniq(paths);
}

const routes = {
  prefix: "/v1/images",

  get: { "/tasks/:taskId": request => recoverPoolTask(request, "image") },
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
        .validate("body.n", v => _.isUndefined(v) || (_.isInteger(v) && v >= 1 && v <= 8))
        .validate("body.filePath", v =>
          _.isUndefined(v) || _.isString(v) || (_.isArray(v) && _.every(v, _.isString))
        )
        .validate("body.filePaths", v =>
          _.isUndefined(v) || (_.isArray(v) && _.every(v, _.isString))
        )
        .validate("headers.authorization", _.isString);
      const {
        model = DEFAULT_MODEL,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        size,
        resolution,
        sample_strength: sampleStrength,
        response_format,
        n = DEFAULT_IMAGE_COUNT,
        filePath: bodyFilePath,
        filePaths: bodyFilePaths,
      } = request.body;
      const credential = await resolveAuthorization(request.headers.authorization, n);
      const token = credential.token;
      const statsKey = credential.managedKey || token;
      
      // 收集 JSON 路径和 multipart/form-data 上传的所有参考图。
      const files = request.files || {};
      const filePaths = collectReferenceImagePaths(bodyFilePath, bodyFilePaths, files);
      if (filePaths.length > MAX_REFERENCE_IMAGES) {
        throw new APIException(
          EX.API_REQUEST_PARAMS_INVALID,
          `最多支持 ${MAX_REFERENCE_IMAGES} 张参考图`
        );
      }

      const responseFormat = _.defaultTo(response_format, "url");
      let imageUrls;
      try {
        imageUrls = (await generateImagesWithRetry(model, prompt, {
          ratio: ratio ?? size,
          resolution,
          sampleStrength,
          negativePrompt,
          filePaths,
          n,
        }, token)).filter((url): url is string => typeof url === "string" && url.trim().length > 0);
        if (imageUrls.length === 0) {
          throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "图像生成未返回有效结果");
        }
        markCredentialSuccess(credential);
      } catch (error) {
        markCredentialFailure(credential);
        throw error;
      }
      
      // 记录统计和媒体
      try {
        db.recordCall(statsKey, model, 0);
        imageUrls.forEach(url => {
          if (url) db.saveMedia('image', url, model, prompt, statsKey);
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

export default withPoolRoutes(routes, "image", DEFAULT_MODEL);
