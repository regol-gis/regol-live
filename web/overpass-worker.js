// The compiler needs no GOL. Instantiate lazily in its own worker so editing
// never interrupts a running query or accesses the query engine's I/O buffers.
let instance;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

self.onmessage = async ({ data: { id, input } }) => {
  try {
    instance ??= WebAssembly.instantiateStreaming(fetch("./regol-live.wasm"), {
      range: {
        get_page: () => 0, suggestion_stopped: () => 0, query_stopped: () => 0,
        fetch_area_file: () => -1, copy_area_file: () => 0,
      },
    }).then(result => result.instance.exports).catch(error => {
      instance = undefined;
      throw error;
    });
    const api = await instance;
    const bytes = encoder.encode(JSON.stringify(input));
    const ptr = api.input_buffer(bytes.length);
    if (!ptr) throw Error("Query is too large.");
    new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
    const size = api.compile_overpass();
    const plan = JSON.parse(decoder.decode(new Uint8Array(api.memory.buffer, api.output_ptr(), size)));
    if (plan?.error) throw Error(plan.error);
    self.postMessage({ id, plan });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
