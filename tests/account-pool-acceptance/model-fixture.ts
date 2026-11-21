export async function resolveImageModelConfig() {
  return { modelReqKey: 'high_aes_general_v40', defaultResolution: '1k', supportedResolutions: ['1k', '2k', '4k'] };
}
export async function resolveVideoModelConfig() {
  return { modelReqKey: 'dreamina_seedance_40_pro', defaultResolution: '720p', supportedResolutions: ['720p', '1080p'], defaultDuration: 5, supportedDurations: [5, 10, 20], supportsLongDuration: true };
}
