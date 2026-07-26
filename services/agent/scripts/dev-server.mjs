import http from "node:http";
import { loadConfig } from "../src/config.mjs";
import { handler } from "../src/index.mjs";

const config = loadConfig();

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const url = new URL(request.url, `http://${request.headers.host}`);
  const event = {
    rawPath: url.pathname,
    headers: request.headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: Buffer.concat(chunks).toString("utf8") || null,
    requestContext: { http: { method: request.method } },
  };
  const result = await handler(event);
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`WORLDLINE agent listening on http://127.0.0.1:${config.port}`);
});
