import { readFile } from "node:fs/promises";
import { recoverPoolTask } from "../../lib/pool-task-recovery.ts";
import { beginPoolSubmission, acceptPoolSubmission, currentPoolTask, finishPoolTask } from "../../lib/pool-task-context.ts";
import { rememberUploadAsset } from "../../lib/pool-task-assets.ts";
import { uploadVideoReference } from "../controllers/video-reference-upload.ts";
import { withPoolRoutes } from "../../lib/pool-task-routes.ts";
import _ from "lodash";
import axios from "axios";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import {
  generateAudio,
  queryAudioStatus,
  rememberAudioTaskCredential,
  resolveAudioTaskCredential,
  waitForAudioCompletion,
} from "@/api/controllers/audios.ts";
import {
  markCredentialFailure,
  markCredentialSuccess,
  resolveAuthorization,
} from "@/api/controllers/auth.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";

function appendUploadedPaths(value: any, target: string[]) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => appendUploadedPaths(item, target));
    return;
  }
  const filePath = value.filepath || value.path;
  if (typeof filePath === "string" && filePath) target.push(filePath);
}

function extractAuthHeader(request: Request): string {
  const auth = request.headers?.authorization;
  if (typeof auth === "string" && auth.trim()) return auth.trim();
  const xApiKey =
    request.headers?.["x-api-key"] || request.headers?.["X-Api-Key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) {
    return `Bearer ${xApiKey.trim()}`;
  }
  return "";
}

function collectReferenceAudiosAndVoice(
  body: Record<string, any>,
  files: Record<string, any> = {}
): { audioPaths: string[]; speaker?: string } {
  const audioPaths: string[] = [];
  let speaker: string | undefined;

  if (Array.isArray(body.audio_paths)) {
    for (const item of body.audio_paths) {
      if (typeof item === "string" && item.trim()) audioPaths.push(item.trim());
    }
  }
  if (Array.isArray(body.audio_urls)) {
    for (const item of body.audio_urls) {
      if (typeof item === "string" && item.trim()) audioPaths.push(item.trim());
    }
  }
  if (Array.isArray(body.audios)) {
    for (const item of body.audios) {
      if (typeof item === "string" && item.trim()) audioPaths.push(item.trim());
    }
  }
  if (Array.isArray(body.references)) {
    for (const ref of body.references) {
      if (!ref || typeof ref !== "object") continue;
      if (typeof ref.audio_url === "string" && ref.audio_url.trim()) {
        audioPaths.push(ref.audio_url.trim());
      } else if (typeof ref.audio_data === "string" && ref.audio_data.trim()) {
        const raw = ref.audio_data.trim();
        audioPaths.push(
          raw.startsWith("data:") ? raw : `data:audio/mpeg;base64,${raw}`
        );
      }
      if (typeof ref.speaker === "string" && ref.speaker.trim()) {
        speaker = ref.speaker.trim();
      }
    }
  }

  if (!_.isEmpty(files)) {
    Object.values(files).forEach((file) =>
      appendUploadedPaths(file, audioPaths)
    );
  }

  return { audioPaths, speaker };
}

function normalizeSpeechRate(body: Record<string, any>): number {
  if (_.isFinite(Number(body.speech_rate))) {
    return Number(body.speech_rate);
  }
  if (_.isFinite(Number(body.audio_config?.speech_rate))) {
    return Number(body.audio_config.speech_rate);
  }
  if (_.isFinite(Number(body.speed)) && Number(body.speed) > 0) {
    return Math.round((Number(body.speed) - 1) * 100);
  }
  return 0;
}

async function resolvePoolAudioTerminal(
  poolContext: ReturnType<typeof currentPoolTask>,
  fallbackTaskId: string
): Promise<{ state: "succeeded" | "failed"; taskId: string; url?: string; failReason?: string } | null> {
  if (!poolContext?.taskId || !poolContext.ownerHash || !poolContext.pool?.readTask) return null;
  let latest: { state: string; upstreamTaskId?: string | null; settling?: boolean; error?: string | null } | undefined;
  try {
    latest = poolContext.pool.readTask(poolContext.taskId, poolContext.ownerHash) as any;
  } catch {
    latest = undefined;
  }
  const state = latest?.state || poolContext.state;
  if (state === "failed") {
    if (latest?.settling) {
      try { await poolContext.pool.settleTask(poolContext.taskId); } catch {}
    }
    return {
      state: "failed",
      taskId: latest?.upstreamTaskId || poolContext.upstreamTaskId || fallbackTaskId,
      failReason: latest?.error || "上游任务失败，未重新提交",
    };
  }
  if (state === "succeeded" && poolContext.pool.readTaskResult) {
    if (latest?.settling) {
      try { await poolContext.pool.settleTask(poolContext.taskId); } catch {}
    }
    let stored: any = null;
    try { stored = poolContext.pool.readTaskResult(poolContext.taskId, poolContext.ownerHash); } catch { stored = null; }
    const storedUrl = Array.isArray(stored?.urls) ? stored.urls.find((u: unknown) => typeof u === "string" && u.trim().length > 0) : undefined;
    if (storedUrl) {
      return {
        state: "succeeded",
        taskId: latest?.upstreamTaskId || poolContext.upstreamTaskId || fallbackTaskId,
        url: storedUrl.trim(),
      };
    }
  }
  return null;
}

type AudioTerminal = NonNullable<Awaited<ReturnType<typeof resolvePoolAudioTerminal>>>;

function formatAudioGenerationTerminal(terminal: AudioTerminal) {
  return {
    created: util.unixTimestamp(),
    data: terminal.state === "succeeded"
      ? {
          task_id: terminal.taskId,
          status: 50,
          state: "succeeded",
          complete: true,
          audio_url: terminal.url,
          url: terminal.url,
        }
      : {
          task_id: terminal.taskId,
          status: 30,
          state: "failed",
          complete: false,
          audio_url: null,
          url: null,
          fail_message: terminal.failReason,
        },
  };
}

function formatAudioCompatTerminal(terminal: AudioTerminal) {
  return terminal.state === "succeeded"
    ? {
        id: terminal.taskId,
        task_id: terminal.taskId,
        status: "succeeded",
        audio_url: terminal.url,
        url: terminal.url,
      }
    : {
        id: terminal.taskId,
        task_id: terminal.taskId,
        status: "failed",
        audio_url: null,
        url: null,
        fail_reason: terminal.failReason,
      };
}

const routes = {
  prefix: "/v1/audios",

  post: {
    "/uploads": async (request: Request) => {
      const authHeader = extractAuthHeader(request);
      const paths: string[] = [];
      Object.values(request.files || {}).forEach(file => appendUploadedPaths(file, paths));
      const source = paths[0] ? `data:audio/mpeg;base64,${(await readFile(paths[0])).toString('base64')}` : request.body?.source;
      if (typeof source !== 'string' || !source.trim() || paths.length > 1) throw new Error('上传需要一份音频文件或 source');
      const credential = await resolveAuthorization(authHeader);
      beginPoolSubmission();
      const asset = await uploadVideoReference(source, credential.token, 'audio', credential.cookie);
      acceptPoolSubmission(asset.vid);
      rememberUploadAsset(asset.vid, asset.durationMs, credential);
      await finishPoolTask('succeeded', undefined, {
        kind: 'upload',
        vid: asset.vid,
        duration_ms: asset.durationMs,
        data: { vid: asset.vid, duration_ms: asset.durationMs },
      });
      return { data: { vid: asset.vid, duration_ms: asset.durationMs }, message: '此 vid 仅限当前调用方和原账号使用，24 小时内有效' };
    },
    "/generations": async (request: Request) => {
      request
        .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
        .validate(
          "body.prompt",
          (v) => _.isUndefined(v) || _.isString(v)
        )
        .validate(
          "body.mode",
          (v) => _.isUndefined(v) || ["tts", "unified_edit"].includes(v)
        )
        .validate("body.voice_name", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.voice", (v) => _.isUndefined(v) || _.isString(v))
        .validate(
          "body.duration",
          (v) => _.isUndefined(v) || _.isFinite(Number(v))
        )
        .validate(
          "body.audio_paths",
          (v) => _.isUndefined(v) || (_.isArray(v) && v.every(_.isString))
        )
        .validate(
          "body.response_format",
          (v) => _.isUndefined(v) || _.isString(v)
        );

      const authHeader = extractAuthHeader(request);
      if (!authHeader) {
        throw new Error("Authorization header is required");
      }

      const credential = await resolveAuthorization(authHeader);
      const token = credential.token;
      const statsKey = credential.managedKey || token;

      const body = request.body || {};
      const prompt = String(
        body.prompt ?? body.text_prompt ?? body.input ?? ""
      );
      const model = body.model || "jimeng-audio-seedaudio-1.0";
      const { audioPaths, speaker } = collectReferenceAudiosAndVoice(
        body,
        request.files || {}
      );
      const mode: "tts" | "unified_edit" =
        body.mode || (audioPaths.length > 0 ? "unified_edit" : "tts");
      const voice_name =
        body.voice_name || body.voice || speaker || "苏感低音";
      const duration = Number(body.duration ?? 5);
      const speech_rate = normalizeSpeechRate(body);
      const pitch_rate = Number(
        body.pitch_rate ?? body.audio_config?.pitch_rate ?? 0
      );
      const format = body.format || body.audio_config?.format || "mp3";
      const response_format = body.response_format || "url";
      const shouldWait =
        body.wait === true ||
        body.wait === "true" ||
        body.sync === true ||
        response_format === "b64_json";

      let audioData;
      try {
        audioData = await generateAudio(
          {
            prompt,
            model,
            mode,
            voice_name,
            duration,
            speech_rate,
            pitch_rate,
            format,
            audioPaths,
          },
          token,
          credential.cookie
        );
        const taskId = audioData.history_record_id || audioData.task?.task_id;
        rememberAudioTaskCredential(
          [taskId, audioData.submit_id, audioData.task?.submit_id],
          credential
        );

        if (shouldWait && taskId) {
          const completed = await waitForAudioCompletion(
            String(taskId),
            token,
            credential.cookie
          );
          markCredentialSuccess(credential);
          try {
            db.recordCall(statsKey, model, 0);
            if (completed.audio_url) {
              db.saveMedia("video", completed.audio_url, model, prompt, statsKey);
            }
          } catch {}

          if (response_format === "b64_json" && completed.audio_url) {
            const b64 = await util.fetchFileBASE64(completed.audio_url);
            return {
              created: util.unixTimestamp(),
              data: {
                task_id: completed.task_id,
                status: completed.status,
                state: completed.state,
                complete: true,
                b64_json: b64,
                audio_url: completed.audio_url,
                url: completed.audio_url,
                model,
                mode,
                prompt,
              },
            };
          }

          return {
            created: util.unixTimestamp(),
            data: {
              task_id: completed.task_id,
              status: completed.status,
              state: completed.state,
              complete: true,
              audio_url: completed.audio_url,
              url: completed.audio_url,
              duration: completed.duration,
              submit_id: audioData.submit_id,
              model,
              mode,
              prompt,
            },
          };
        }

        markCredentialSuccess(credential);
      } catch (error) {
        markCredentialFailure(credential);
        throw error;
      }

      try {
        db.recordCall(statsKey, model, 0);
      } catch {}

      const taskId = audioData.history_record_id || audioData.task?.task_id;
      return {
        created: util.unixTimestamp(),
        data: {
          task_id: taskId,
          status: audioData.status,
          state: "processing",
          complete: false,
          submit_id: audioData.submit_id,
          model,
          mode,
          prompt,
        },
      };
    },
  },

  get: {
    "/tasks/:taskId": request => recoverPoolTask(request, "audio"),
    "/generations/:taskId": async (request: Request) => {
      const { taskId } = request.params;
      const authHeader = extractAuthHeader(request);
      const credential = await resolveAudioTaskCredential(taskId, authHeader);
      const poolContext = currentPoolTask();
      const beforeTerminal = await resolvePoolAudioTerminal(poolContext, credential.upstreamTaskId || taskId);
      if (beforeTerminal) return formatAudioGenerationTerminal(beforeTerminal);

      let statusData;
      try {
        statusData = await queryAudioStatus(
          credential.upstreamTaskId || taskId,
          credential.token,
          credential.cookie
        );
      } catch (error) {
        const catchTerminal = await resolvePoolAudioTerminal(poolContext, credential.upstreamTaskId || taskId);
        if (catchTerminal) return formatAudioGenerationTerminal(catchTerminal);
        throw error;
      }

      const afterTerminal = await resolvePoolAudioTerminal(poolContext, statusData.task_id || credential.upstreamTaskId || taskId);
      if (afterTerminal) return formatAudioGenerationTerminal(afterTerminal);

      return {
        created: util.unixTimestamp(),
        data: {
          task_id: statusData.task_id,
          submit_id: statusData.submit_id,
          status: statusData.status,
          state: statusData.state,
          complete: statusData.complete,
          audio_url: statusData.audio_url,
          url: statusData.audio_url,
          duration: statusData.duration,
          fail_code: statusData.fail_code,
          fail_message: statusData.fail_message,
        },
      };
    },
  },
};

/**
 * 客户端音频协议兼容路由：
 * 1. POST /api/v3/tts/create       -> 兼容 doubao-streaming-tts 插件（支持音色 TTS 与最多 3 段参考音频的全能配音 unified_edit）
 * 2. POST /v1/audio/tasks          -> 兼容 async-audio 插件创建任务
 * 3. GET  /v1/audio/tasks/:taskId  -> 兼容 async-audio 插件轮询任务
 * 4. POST /v1/audio/speech         -> 兼容 openai-audio 插件同步返回音频二进制流
 */
const compatRoutes = [
  {
    prefix: "/api/v3/tts",
    post: {
      "/create": async (request: Request) => {
        const authHeader = extractAuthHeader(request);
        if (!authHeader) {
          throw new Error("API key is required");
        }
        const credential = await resolveAuthorization(authHeader);
        const token = credential.token;
        const statsKey = credential.managedKey || token;

        const body = request.body || {};
        const prompt = String(
          body.text_prompt ?? body.prompt ?? body.input ?? ""
        );
        const model = body.model || "jimeng-audio-seedaudio-1.0";
        const { audioPaths, speaker } = collectReferenceAudiosAndVoice(
          body,
          request.files || {}
        );
        const explicitMode =
          body.mode === "tts" || body.mode === "unified_edit"
            ? body.mode
            : body.audio_mode === "tts" || body.audio_mode === "unified_edit"
              ? body.audio_mode
              : undefined;
        const mode: "tts" | "unified_edit" =
          explicitMode || (audioPaths.length > 0 ? "unified_edit" : "tts");
        const voice_name =
          body.voice_name || body.voice || speaker || "苏感低音";
        const duration = Number(body.duration ?? 5);
        const speech_rate = normalizeSpeechRate(body);
        const format = body.audio_config?.format || body.format || "mp3";

        try {
          const audioData = await generateAudio(
            {
              prompt,
              model,
              mode,
              voice_name,
              duration,
              speech_rate,
              format,
              audioPaths,
            },
            token,
            credential.cookie
          );
          const taskId = audioData.history_record_id || audioData.task?.task_id;
          rememberAudioTaskCredential(
            [taskId, audioData.submit_id, audioData.task?.submit_id],
            credential
          );
          const completed = await waitForAudioCompletion(
            String(taskId),
            token,
            credential.cookie
          );
          markCredentialSuccess(credential);
          try {
            db.recordCall(statsKey, model, 0);
          } catch {}

          return {
            task_id: completed.task_id,
            status: "succeeded",
            url: completed.audio_url,
            audio_url: completed.audio_url,
            duration: completed.duration,
          };
        } catch (error) {
          markCredentialFailure(credential);
          throw error;
        }
      },
    },
  },
  {
    prefix: "/v1/audio",
    post: {
      "/tasks": async (request: Request) => {
        const authHeader = extractAuthHeader(request);
        if (!authHeader) {
          throw new Error("Authorization header is required");
        }
        const credential = await resolveAuthorization(authHeader);
        const token = credential.token;
        const statsKey = credential.managedKey || token;

        const body = request.body || {};
        const prompt = String(
          body.input ?? body.prompt ?? body.text_prompt ?? ""
        );
        const model = body.model || "jimeng-audio-seedaudio-1.0";
        const { audioPaths, speaker } = collectReferenceAudiosAndVoice(
          body,
          request.files || {}
        );
        const mode: "tts" | "unified_edit" =
          body.mode || (audioPaths.length > 0 ? "unified_edit" : "tts");
        const voice_name =
          body.voice_name || body.voice || speaker || "苏感低音";
        const duration = Number(body.duration ?? 5);
        const speech_rate = normalizeSpeechRate(body);
        const format = body.response_format || body.format || "mp3";

        try {
          const audioData = await generateAudio(
            {
              prompt,
              model,
              mode,
              voice_name,
              duration,
              speech_rate,
              format,
              audioPaths,
            },
            token,
            credential.cookie
          );
          const taskId = audioData.history_record_id || audioData.task?.task_id;
          rememberAudioTaskCredential(
            [taskId, audioData.submit_id, audioData.task?.submit_id],
            credential
          );
          markCredentialSuccess(credential);
          try {
            db.recordCall(statsKey, model, 0);
          } catch {}

          return {
            id: String(taskId),
            task_id: String(taskId),
            status: "processing",
          };
        } catch (error) {
          markCredentialFailure(credential);
          throw error;
        }
      },
      "/speech": async (request: Request) => {
        const authHeader = extractAuthHeader(request);
        if (!authHeader) {
          throw new Error("Authorization header is required");
        }
        const credential = await resolveAuthorization(authHeader);
        const token = credential.token;
        const statsKey = credential.managedKey || token;

        const body = request.body || {};
        const prompt = String(
          body.input ?? body.prompt ?? body.text_prompt ?? ""
        );
        const model = body.model || "jimeng-audio-seedaudio-1.0";
        const { audioPaths, speaker } = collectReferenceAudiosAndVoice(
          body,
          request.files || {}
        );
        const mode: "tts" | "unified_edit" =
          body.mode || (audioPaths.length > 0 ? "unified_edit" : "tts");
        const voice_name =
          body.voice_name || body.voice || speaker || "苏感低音";
        const duration = Number(body.duration ?? 5);
        const speech_rate = normalizeSpeechRate(body);

        try {
          const audioData = await generateAudio(
            {
              prompt,
              model,
              mode,
              voice_name,
              duration,
              speech_rate,
              format: "mp3",
              audioPaths,
            },
            token,
            credential.cookie
          );
          const taskId = audioData.history_record_id || audioData.task?.task_id;
          rememberAudioTaskCredential(
            [taskId, audioData.submit_id, audioData.task?.submit_id],
            credential
          );
          const completed = await waitForAudioCompletion(
            String(taskId),
            token,
            credential.cookie
          );
          markCredentialSuccess(credential);
          try {
            db.recordCall(statsKey, model, 0);
          } catch {}

          const audioStreamResp = await axios.get(completed.audio_url!, {
            responseType: "arraybuffer",
            timeout: 60000,
          });
          const audioBuffer = Buffer.from(audioStreamResp.data);
          return new Response(audioBuffer, {
            type: "audio/mpeg",
            size: audioBuffer.length,
          });
        } catch (error) {
          markCredentialFailure(credential);
          throw error;
        }
      },
    },
    get: {
      "/tasks/:taskId": async (request: Request) => {
        const { taskId } = request.params;
        const authHeader = extractAuthHeader(request);
        const credential = await resolveAudioTaskCredential(taskId, authHeader);
        const poolContext = currentPoolTask();
        const beforeTerminal = await resolvePoolAudioTerminal(poolContext, credential.upstreamTaskId || taskId);
        if (beforeTerminal) return formatAudioCompatTerminal(beforeTerminal);

        try {
          const statusData = await queryAudioStatus(
            credential.upstreamTaskId || taskId,
            credential.token,
            credential.cookie
          );

          const afterTerminal = await resolvePoolAudioTerminal(poolContext, statusData.task_id || credential.upstreamTaskId || taskId);
          if (afterTerminal) return formatAudioCompatTerminal(afterTerminal);

          return {
            id: statusData.task_id,
            task_id: statusData.task_id,
            status: statusData.state,
            audio_url: statusData.audio_url,
            url: statusData.audio_url,
            fail_reason: statusData.fail_message,
          };
        } catch (error) {
          const catchTerminal = await resolvePoolAudioTerminal(poolContext, credential.upstreamTaskId || taskId);
          if (catchTerminal) return formatAudioCompatTerminal(catchTerminal);
          throw error;
        }
      },
    },
  },
];

export const audioCompatRoutes = compatRoutes.map(route => withPoolRoutes(route, "audio", "jimeng-audio-seedaudio-1.0"));

export default withPoolRoutes(routes, "audio", "jimeng-audio-seedaudio-1.0");
