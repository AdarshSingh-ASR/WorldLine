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
  assert.match(html, /WORLDLINE/);
  assert.match(html, /EPISODIC MEMORY/);
  assert.match(html, /Commit both futures/);
  assert.match(html, /TRANSACTION LOG/);
  assert.match(html, /REGION HEALTH/);
  assert.match(html, /PREDICTED AIRSPACE/);
  assert.match(
    html,
    /rel="icon"[^>]*href="https:\/\/worldline\.example\/brand\/worldline-mark\.svg"/i,
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

test("renders the connecting state rather than a fabricated world", async () => {
  const html = await (await render()).text();
  // The server cannot know live cluster state, so the shell must ship the
  // unresolved state. A pre-baked similarity score or committed route in the
  // server HTML would mean the interface is not reading the real backend.
  assert.match(html, /CONNECTING|No authoritative world state|awaiting recall/i);
  assert.doesNotMatch(html, /MEM-2041/);
  assert.doesNotMatch(html, /94%/);
  assert.doesNotMatch(html, /RCP-7F31A9/);
});

test("carries no hardcoded scenario values in the client bundle sources", async () => {
  const [control, viewport, client] = await Promise.all([
    readFile(new URL("../app/components/ControlRoom.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/AirspaceViewport.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/worldline.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [control, viewport, client]) {
    // Values that must only ever arrive from the agent.
    assert.doesNotMatch(source, /MEM-2041|RCP-7F31A9|18\.4 m\/s|11\.2 kn/);
    assert.doesNotMatch(source, /UTM-4\.7/);
  }
  // No simulated pacing anywhere in the control surface.
  assert.doesNotMatch(control, /setTimeout\s*\(/);
  assert.doesNotMatch(viewport, /setTimeout\s*\(/);
});
