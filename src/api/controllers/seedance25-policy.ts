import type { JimengModelConfig } from "./models.ts";

export type Seedance25Options = {
  duration?: number;
  resolution?: string;
  functionMode?: "omni_reference";
  filePaths?: string[];
  videoPaths?: string[];
  audioPaths?: string[];
};

// Apply the adapter's verified limits even when called without the HTTP route.
export function validateSeedance25Options(config: JimengModelConfig, options: Seedance25Options) {
  if (config.modelReqKey !== "dreamina_seedance_45_pro") return;
  const { duration, resolution = "720p", functionMode, filePaths = [], videoPaths = [], audioPaths = [] } = options;
  if (resolution !== "720p") throw new Error("Seedance 2.5 目前仅适配 720p");
  if (functionMode === "omni_reference") {
    if (!Number.isInteger(duration) || duration! < 5 || duration! > 30 || !config.supportedDurations?.includes(duration!) || !filePaths.length || filePaths.length > 9 || videoPaths.length || audioPaths.length) {
      throw new Error("Seedance 2.5 全能参考目前仅适配 720p、5 至 30 秒图片参考");
    }
  } else if ((duration !== undefined && ![5, 10].includes(duration)) || filePaths.length > 2 || videoPaths.length || audioPaths.length) {
    throw new Error("Seedance 2.5 非全能模式仅支持 5/10 秒及最多两张图片");
  }
}
