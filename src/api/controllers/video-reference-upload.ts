import axios from "axios";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { request } from "./core.ts";
import util from "@/lib/util.ts";

const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;
const VOD_ORIGIN = "https://vod.bytedanceapi.com";

export interface UploadedReference {
  vid: string;
  width: number;
  height: number;
  durationMs: number;
}

function publicAddress(address: string) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    return !(lower === "::" || lower === "::1" || lower.startsWith("fc") ||
      lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("::ffff:"));
  }
  return false;
}

async function readReference(source: string): Promise<Buffer> {
  if (source.startsWith("data:")) {
    const match = /^data:(video|audio)\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (!match || match[2].length > MAX_REFERENCE_BYTES * 4 / 3 + 8) throw new Error("参考素材格式或大小无效");
    const data = Buffer.from(match[2], "base64");
    if (!data.length || data.length > MAX_REFERENCE_BYTES) throw new Error("参考素材大小无效");
    return data;
  }
  const url = new URL(source);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hostname.endsWith(".local")) {
    throw new Error("参考素材必须使用公网 HTTPS 地址");
  }
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname, family: net.isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error("参考素材地址不是公网地址");
  const pinned = addresses[0];
  const agent = new https.Agent({ lookup: (_hostname, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  } });
  const response = await axios.get(url.href, {
    responseType: "arraybuffer", maxRedirects: 0, maxContentLength: MAX_REFERENCE_BYTES,
    timeout: 60000, httpsAgent: agent, proxy: false,
  });
  const data = Buffer.from(response.data);
  if (!data.length || data.length > MAX_REFERENCE_BYTES) throw new Error("参考素材大小无效");
  return data;
}

function signedVodHeaders(method: "GET" | "POST", url: URL, body: string, credentials: any) {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const headers: Record<string, string> = {
    "x-amz-date": stamp,
    "x-amz-security-token": credentials.session_token,
  };
  if (method === "POST") headers["x-amz-content-sha256"] = hash(body);
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const canonical = [method, url.pathname, query, names.map((name) => `${name}:${headers[name].trim()}\n`).join(""), names.join(";"), hash(body)].join("\n");
  const scope = `${day}/cn-north-1/vod/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hash(canonical)].join("\n");
  const hmac = (key: Buffer | string, value: string) => crypto.createHmac("sha256", key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secret_access_key}`, day), "cn-north-1"), "vod"), "aws4_request");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.access_key_id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${crypto.createHmac("sha256", key).update(toSign).digest("hex")}`;
  return headers;
}

export async function uploadVideoReference(source: string, refreshToken: string, kind: "video" | "audio", cookie?: string): Promise<UploadedReference> {
  const bytes = await readReference(source);
  const credentials = await request("POST", "/mweb/v1/get_upload_token", refreshToken, { cookie, data: { scene: 1 } });
  if (!credentials?.access_key_id || !credentials?.secret_access_key || !credentials?.session_token || !credentials?.space_name) {
    throw new Error("获取参考素材上传令牌失败");
  }
  const applyUrl = new URL(VOD_ORIGIN);
  applyUrl.search = new URLSearchParams({ Action: "ApplyUploadInner", Version: "2020-11-19", SpaceName: credentials.space_name,
    FileType: "video", IsInner: "1", FileSize: String(bytes.length), s: crypto.randomBytes(6).toString("hex") }).toString();
  const browserHeaders = { origin: "https://jimeng.jianying.com", referer: "https://jimeng.jianying.com/ai-tool/generate" };
  const apply = await axios.get(applyUrl.href, { headers: { ...signedVodHeaders("GET", applyUrl, "", credentials), ...browserHeaders }, timeout: 30000, proxy: false });
  if (apply.data?.ResponseMetadata?.Error) throw new Error(`参考素材申请上传失败：${apply.data.ResponseMetadata.Error.Code || "upstream"}`);
  const node = apply.data?.Result?.InnerUploadAddress?.UploadNodes?.[0];
  const store = node?.StoreInfos?.[0];
  if (!node?.UploadHost || !node?.SessionKey || !store?.StoreUri || !store?.Auth) throw new Error("参考素材上传地址缺失");
  const uploadHost = String(node.UploadHost);
  if (!/^[a-z0-9.-]+$/i.test(uploadHost) || !(uploadHost.endsWith(".byteimg.com") || uploadHost.endsWith(".bytedance.com") || uploadHost.endsWith(".bytedancevod.com") || uploadHost.endsWith(".douyin.com") || uploadHost.endsWith(".volces.com") || uploadHost.endsWith(".volcengine.com") || uploadHost.endsWith(".volcengineapi.com") || uploadHost.endsWith(".snssdk.com") || uploadHost.endsWith(".vodupload.com") || uploadHost === "vod.bytedanceapi.com")) {
    const diagnosticHost = uploadHost.match(/^(?:https?:\/\/)?([a-z0-9.-]+)/i)?.[1] || "unrecognized";
    throw new Error(`参考素材上传主机无效：${diagnosticHost}`);
  }
  const uploadUrl = `https://${uploadHost}/upload/v1/${String(store.StoreUri).replace(/^\/+/, "")}`;
  const uploaded = await axios.post(uploadUrl, bytes, { headers: { Authorization: store.Auth,
    "Content-CRC32": (util.crc32(bytes) >>> 0).toString(16), "Content-Type": "application/octet-stream", ...browserHeaders },
    maxBodyLength: MAX_REFERENCE_BYTES, timeout: 120000, proxy: false });
  if (uploaded.data?.code !== 2000) throw new Error(`参考素材上传失败：${uploaded.data?.code ?? "upstream"}`);
  const commitUrl = new URL(VOD_ORIGIN);
  commitUrl.search = new URLSearchParams({ Action: "CommitUploadInner", Version: "2020-11-19", SpaceName: credentials.space_name }).toString();
  const body = JSON.stringify({ SessionKey: node.SessionKey, Functions: [] });
  const committed = await axios.post(commitUrl.href, body, { headers: { ...signedVodHeaders("POST", commitUrl, body, credentials),
    "content-type": "application/json", ...browserHeaders }, timeout: 30000, proxy: false });
  if (committed.data?.ResponseMetadata?.Error) throw new Error(`参考素材提交失败：${committed.data.ResponseMetadata.Error.Code || "upstream"}`);
  const result = committed.data?.Result?.Results?.[0];
  if (!result?.Vid) throw new Error("参考素材提交后未返回 Vid");
  const metadata = result.VideoMeta || {};
  const durationMs = Math.round(Number(metadata.Duration || 0) * 1000);
  if (kind === "video" && durationMs > 15000) throw new Error("参考视频不能超过 15 秒");
  return { vid: result.Vid, width: Number(metadata.Width || 0), height: Number(metadata.Height || 0), durationMs };
}
