import http from "node:http";
import { access, stat } from "node:fs/promises";
import sirv from "sirv";
import { createTileHints } from "./tile-hints.mjs";
import { localStartView } from "./start-view.mjs";
import { serveDataset } from "./datasets.mjs";

await access("dist/regol-live.wasm");
const ukPath = process.env.UK_GOL;
const serveHints = ukPath && createTileHints(ukPath);
const getView = ukPath && localStartView(ukPath);
const datasets = [
  {
    id: "planet-proxy",
    label: "Planet · local proxy",
    path: "./datasets/planet.gol",
  },
];
if (ukPath) {
  if (!(await stat(ukPath)).isFile())
    throw Error("UK_GOL must point to a GOL file.");
  datasets.unshift({
    id: "uk",
    localFile: true,
    hints: "./datasets/uk-tiles.json",
    label: "United Kingdom · local",
    path: "./datasets/uk.gol",
  });
}
const files = sirv("dist", { etag: true, dev: true });
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];
  if (serveHints && pathname === "/datasets/uk-tiles.json")
    return void serveHints(req, res);
  if (pathname === "/local-datasets.js") {
    const view = getView && await getView().catch(() => undefined);
    const config = datasets.map((item) => item.localFile ? { ...item, view } : item);
    return res
      .writeHead(200, {
        "Content-Type": "text/javascript",
        "Cache-Control": "no-store",
      })
      .end("export default " + JSON.stringify(config) + ";");
  }
  if (
    pathname === "/datasets/planet.gol" ||
    (ukPath && pathname === "/datasets/uk.gol")
  ) {
    return void serveDataset(req, res, {
      ukPath,
      planet: pathname === "/datasets/planet.gol",
    });
  }
  files(req, res, () => res.writeHead(404).end("File not found"));
});
const port = Number(process.env.PORT || 4173);
server.listen(port, "127.0.0.1", () =>
  console.log(
    "Regol Live at http://127.0.0.1:" +
      server.address().port +
      (ukPath ? "/?dataset=uk" : "/"),
  ),
);
