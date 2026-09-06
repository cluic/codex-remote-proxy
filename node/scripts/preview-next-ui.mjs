import http from "node:http";

import { createFixtureHarness } from "../test/e2e/crp-ui-fixture.mjs";

const host = "127.0.0.1";
const port = Number(process.env.CRP_PREVIEW_PORT ?? "4318");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CRP_PREVIEW_PORT is invalid.");

const fixture = await createFixtureHarness();
fixture.harness.seedProviders({
  providers: [
    { id: "provider-a", name: "Provider Alpha", baseUrl: fixture.harness.upstreamBaseUrl },
    { id: "provider-b", name: "Provider Beta", baseUrl: fixture.harness.upstreamBaseUrl }
  ],
  activeProviderId: "provider-a"
});
const target = new URL(fixture.harness.origin);
const session = await fetch(`${target.origin}/api/v1/session`, {
  method: "POST",
  headers: { authorization: `Bearer ${fixture.harness.controlToken}` }
});
const previewCookie = session.headers.getSetCookie?.()[0] ?? session.headers.get("set-cookie");
if (!session.ok || !previewCookie) throw new Error("Unable to create the isolated preview session.");

const server = http.createServer((request, response) => {
  const headers = { ...request.headers, host: target.host };
  if (headers.origin !== undefined) headers.origin = target.origin;
  const proxy = http.request({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, { ...upstream.headers, "set-cookie": previewCookie });
    upstream.pipe(response);
  });
  proxy.once("error", () => response.writeHead(502).end());
  request.pipe(proxy);
});
const shutdown = async () => {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await fixture.cleanup();
};
server.once("error", async (error) => {
  await fixture.cleanup();
  throw error;
});
await new Promise((resolvePromise) => server.listen(port, host, resolvePromise));
process.stdout.write(`CRP Next UI preview: http://localhost:${port}/\n`);
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
