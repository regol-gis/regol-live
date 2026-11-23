import { planetURL } from "./ranges.js";

export const hostedPlanetIndexURL = new URL("./datasets/planet.gol.areas", import.meta.url).href;
const utf8 = new TextDecoder();
const encoder = new TextEncoder();

// A GOB view may cover only a downloaded region. Global probes need the full GOL.
export function hasNamedAreas(request) {
  return (request.sets ?? []).some(set => set.overpass?.namedArea);
}

async function readLimited(body, limit) {
  const reader = body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          return null;
        }
        if (value.length) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { size, chunks };
}

function webManifest(bytes, openPlanetSnapshot) {
  let manifest;
  try {
    manifest = JSON.parse(utf8.decode(bytes));
  } catch {
    return null; // Forward ordinary parse diagnostics to the Rust reader.
  }
  if (!manifest?.storage) return null;
  const { storage, coverage, attribution, ...original } = manifest;
  const { snapshot } = original;
  if (storage.format !== "gzip" || !/^v1-[0-9a-f]+-[0-9a-f]+-\d+$/.test(snapshot) ||
      typeof storage.directory !== "string" || !storage.directory.startsWith(snapshot + "-") ||
      !/^[0-9a-f]{16}$/.test(storage.directory.slice(snapshot.length + 1))) {
    throw Error("Invalid named-area storage manifest");
  }
  // The stored generation identifies the source of the coordinates. For the hosted
  // planet, bind these search windows to the open GOL for the duration of the query.
  // Rust still checks shard contents and applies the selection against live features.
  const queryManifest = openPlanetSnapshot ? { ...original, snapshot: openPlanetSnapshot } : original;
  return { queryManifest, directory: storage.directory };
}

// The WASM query is suspended during fetch. It allocates a buffer of the
// required size on resumption, then consumes these chunks before the next read.
export function areaIndexFiles(memory, golURL, indexURL) {
  let pending, storage;
  return {
    async fetch_area_file(pathPtr, pathSize, limit, snapshotPtr, snapshotSize) {
      pending = undefined;
      const path = utf8.decode(new Uint8Array(memory().buffer, pathPtr >>> 0, pathSize));
      const isManifest = path === "manifest.json";
      if (isManifest) storage = undefined;
      const index = indexURL();
      const openPlanetSnapshot = isManifest && golURL === planetURL && index === hostedPlanetIndexURL && snapshotSize
        ? utf8.decode(new Uint8Array(memory().buffer, snapshotPtr >>> 0, snapshotSize))
        : undefined;
      const url = new URL(index ?? golURL);
      let filename = path;
      if (storage) {
        const [snapshot, shard] = path.split("/");
        if (snapshot !== storage.queryManifest.snapshot || !/^[0-9a-f]{2}\.json$/.test(shard)) return -1;
        filename = storage.directory + "/" + shard + ".gz";
      }
      url.pathname = url.pathname.replace(/\/$/, "") + (index ? "/" : ".areas/") + filename;
      url.hash = "";
      try {
        const response = await fetch(url, { cache: isManifest ? "no-cache" : "force-cache" });
        if (!response.ok) return -1;
        let data = await readLimited(response.body, limit);
        if (!data) return -2;
        if (isManifest) {
          storage = webManifest(await new Blob(data.chunks).arrayBuffer(), openPlanetSnapshot);
          if (storage) {
            const bytes = encoder.encode(JSON.stringify(storage.queryManifest));
            data = { chunks: [bytes], size: bytes.length };
          }
        } else if (storage) {
          const blob = new Blob(data.chunks);
          const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
          if (magic[0] === 0x1f && magic[1] === 0x8b) {
            data = await readLimited(blob.stream().pipeThrough(new DecompressionStream("gzip")), limit);
            if (!data) return -2;
          } else if (response.headers.get("Content-Encoding") !== "gzip") {
            return -1;
          }
        }
        pending = data;
        return data.size;
      } catch {
        return -1;
      }
    },
    copy_area_file(destination, size) {
      if (!pending || pending.size !== size) return 0;
      const target = new Uint8Array(memory().buffer, destination >>> 0, size);
      let offset = 0;
      for (const chunk of pending.chunks) {
        target.set(chunk, offset);
        offset += chunk.length;
      }
      pending = undefined;
      return 1;
    },
  };
}
