/** Both the images API and image chat request one image unless the image route supplies n. */
export const DEFAULT_IMAGE_COUNT = 1;

/** Preserve upstream ordering and select at most the requested number of usable images. */
export function selectGeneratedImageUrls(items: any[], requestedImageCount?: number | null): string[] {
  const urls = items
    .map(item => item?.image?.large_images?.[0]?.image_url || item?.common_attr?.cover_url)
    .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    .map(url => url.trim());
  return requestedImageCount == null ? urls : urls.slice(0, requestedImageCount);
}
