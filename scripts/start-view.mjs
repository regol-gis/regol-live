// Use the same Wasm selector as remote clients, with synchronous reads from the
// open local file. Reuse the result until the file's range validator changes.
import { open, readFile } from "node:fs/promises";
import { readSync } from "node:fs";
import { localETag } from "./datasets.mjs";

export function localStartView(path) {
  let cached, module;
  return async () => {
    const file = await open(path, "r");
    try {
      const stat = await file.stat({ bigint: true });
      const etag = localETag(stat);
      if (cached?.etag === etag) return cached.view;
      module ??= await WebAssembly.compile(await readFile("dist/regol-live.wasm"));
      const instance = new WebAssembly.Instance(module, {
        range: {
          suggestion_stopped: () => 0,
          query_stopped: () => 0,
          fetch_area_file: () => -1,
          copy_area_file: () => 0,
          get_page(offset, destination, size) {
            const bytes = new Uint8Array(instance.exports.memory.buffer, destination, size);
            let read = 0;
            while (read < size) {
              const n = readSync(file.fd, bytes, read, size - read, Number(offset) + read);
              if (!n) return 0;
              read += n;
            }
            return 1;
          },
        },
      });
      const api = instance.exports;
      if (api.open_gol(stat.size, false)) return;
      const length = api.start_view();
      const bytes = new Uint8Array(api.memory.buffer, api.output_ptr(), length);
      const view = JSON.parse(new TextDecoder().decode(bytes));
      if (localETag(await file.stat({ bigint: true })) !== etag) return;
      cached = { etag, view };
      return view;
    } finally {
      await file.close();
    }
  };
}
