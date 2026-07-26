import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("https://worldline.example/", {
      headers: {
        accept: "text/html",
        host: "worldline.example",
        "x-forwarded-host": "worldline.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the WORLDLINE memory control room", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>WORLDLINE — Remember the future<\/title>/i);
  assert.match(html, /The future has happened before/);
  assert.match(html, /EPISODIC MEMORY/);
  assert.match(html, /Commit both futures/);
  assert.match(html, /SERIALIZABLE ADMISSION/);
  assert.match(html, /CHANGEFEED WITNESS/);
  assert.match(
    html,
    /rel="icon"[^>]*href="https:\/\/worldline\.example\/og\.png"/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("publishes an absolute product social card", async () => {
  const html = await (await render()).text();
  assert.match(
    html,
    /<meta(?=[^>]*property="og:image")(?=[^>]*content="https:\/\/worldline\.example\/og\.png")[^>]*>/i,
  );
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  await access(new URL("../public/og.png", import.meta.url));
});

test("keeps the project isolated and removes starter assets", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
});
