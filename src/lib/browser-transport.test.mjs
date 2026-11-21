import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Use the public request entry point, with only the database, logger and browser driver replaced.
const { outputFiles } = await build({
  stdin: {
    contents: 'export { default as transport } from "./browser-transport.ts"; export { chromium } from "playwright-core";',
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true, write: false, format: "esm", platform: "node", target: "node22",
  plugins: [{ name: "browser-fixtures", setup(builder) {
    builder.onResolve({ filter: /^(?:playwright-core|\.\/(?:logger|database)\.ts)$/ }, args => ({
      path: args.path, namespace: "fixtures",
    }));
    builder.onLoad({ filter: /.*/, namespace: "fixtures" }, ({ path }) => ({
      contents: path === "playwright-core" ? "export const chromium = {};" :
        path.includes("database") ? "export const getSetting = () => null, setSetting = () => {};" :
        "export default {info() {}, warn() {}};",
    }));
  } }],
});
const { transport, chromium } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));

function fixture(t) {
  const contexts = [];
  const attempts = [];
  let failOnce = false;
  chromium.launch = async () => {
    let connected = true;
    const owned = [];
    return {
      isConnected: () => connected,
      async close() { connected = false; await Promise.all(owned.map(context => context.close())); },
      async newContext() {
        const cookies = new Map();
        const context = {
          closed: false, boots: [], storage: null,
          async addCookies(values) { for (const { name, value } of values) cookies.set(name, value); },
          async close() { this.closed = true; },
          async newPage() {
            return {
              isClosed: () => context.closed,
              goto: async () => context.boots.push(cookies.get("sessionid") || null),
              waitForTimeout: async () => {},
              evaluate: async (_fn, payload) => {
                if (!payload) return true;
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(context.closed, false);
                const url = new URL(payload.url);
                attempts.push(url.pathname);
                const data = { sid: cookies.get("sessionid") ?? null, extra: cookies.has("extra"),
                  guard: cookies.get("sid_guard") ?? null, storage: context.storage,
                  boot: context.boots[0], context: contexts.indexOf(context) };
                context.storage = "written";
                if (failOnce) { failOnce = false; return { status: 0, error: "disconnected" }; }
                return { status: 200, statusText: "OK", text: JSON.stringify(data) };
              },
            };
          },
        };
        contexts.push(context);
        owned.push(context);
        return context;
      },
    };
  };
  t.after(() => transport.close());
  return {
    contexts, attempts, failNext() { failOnce = true; },
    async send(cookiePairs, method = "GET", path = "/fixture") {
      const response = await transport.request({ method, url: "https://fixture.invalid" + path, params: {}, headers: {}, cookiePairs });
      return response.data;
    },
  };
}

const a = [["sessionid", "aaa"], ["extra", "fixture"]];
const b = [["sessionid", "bbb"]];

test("switching credentials discards cookies, browser storage and the previous page, even for equal-length values", async t => {
  const f = fixture(t);
  const first = await f.send(a);
  assert.equal(first.boot, "aaa");
  assert.equal((await f.send([...a].reverse())).storage, "written");
  const second = await f.send(b);
  assert.deepEqual([second.boot, second.sid, second.extra, second.storage], ["bbb", "bbb", false, null]);
  const rotated = await f.send([["sessionid", "ccc"]]);
  assert.deepEqual([rotated.boot, rotated.sid, rotated.storage], ["ccc", "ccc", null]);
  const anonymous = await f.send([]);
  assert.deepEqual([anonymous.boot, anonymous.sid, anonymous.extra, anonymous.storage], [null, null, false, null]);
  const nextAnonymous = await f.send([]);
  assert.equal(nextAnonymous.storage, null);
  assert.deepEqual(f.contexts.map(c => c.closed), [true, true, true, true, false]);
});

test("overlapping requests from two accounts run only in their credential's page", async t => {
  const f = fixture(t);
  const results = await Promise.all([f.send(a), f.send(b), f.send(a)]);
  assert.deepEqual(results.map(r => [r.sid, r.boot, r.storage, r.extra]), [
    ["aaa", "aaa", null, true], ["bbb", "bbb", null, false], ["aaa", "aaa", null, true],
  ]);
});

test("a changing generated sid_guard timestamp updates the cookie while retaining the same session", async t => {
  const f = fixture(t);
  const guard = n => "aaa%7C" + n + "%7C5184000%7CMon%2C+03-Feb-2025+08%3A17%3A09+GMT";
  const pair = n => [["sessionid", "aaa"], ["sessionid_ss", "aaa"], ["sid_tt", "aaa"], ["sid_guard", guard(n)]];
  const first = await f.send(pair(123));
  const next = await f.send(pair(124));
  assert.deepEqual([next.context, next.guard, next.storage], [first.context, guard(124), "written"]);
  const other = await f.send([...pair(125), ["extra", "different"]]);
  assert.notEqual(other.context, first.context);
  assert.equal(other.storage, null);
});

test("an ambiguous network failure never replays a submission or an unknown POST; a known read can retry", async t => {
  const f = fixture(t);
  for (const path of ["/mweb/v1/aigc_draft/generate", "/unknown-write"]) {
    f.failNext();
    await assert.rejects(f.send(a, "post", path), /disconnected/);
    assert.equal(f.attempts.filter(value => value === path).length, 1);
  }
  f.failNext();
  const history = "/mweb/v1/get_history_by_ids";
  assert.equal((await f.send(b, "POST", history)).sid, "bbb");
  assert.equal(f.attempts.filter(value => value === history).length, 2);
});
