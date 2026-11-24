// Map output starts with the features array. Keep diagnostic and planning
// messages on the normal worker path, including with an older engine.
const featuresPrefix = '{"features":[';
const nextFeature = ',{"type":"Feature",';
const batchChars = 384 * 1024;
const utf8 = new TextDecoder();

export function engineJSON(api, length, forDisplay = false) {
  const bytes = new Uint8Array(api.memory.buffer, api.output_ptr() >>> 0, length);
  const text = utf8.decode(bytes);
  return forDisplay && length >= 128 * 1024 && text.startsWith(featuresPrefix)
    ? { resultJSON: text }
    : JSON.parse(text);
}

function nextTask() {
  if (globalThis.scheduler?.yield) return scheduler.yield();
  return new Promise(resolve => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); port2.close(); resolve(); };
    port2.postMessage(0);
  });
}

export async function decodeDisplayResult(text, current) {
  if (text.length < 2 * batchChars || !text.startsWith(featuresPrefix)) return JSON.parse(text);
  const features = [];
  let start = featuresPrefix.length;
  for (;;) {
    // A literal JSON key cannot occur inside an escaped tag string. Only cut
    // at a complete array element. Other schemas can always use the full parser.
    const cut = text.indexOf(nextFeature, start + batchChars);
    let batch, tail;
    try {
      if (cut < 0) {
        tail = JSON.parse(featuresPrefix + text.slice(start));
        batch = tail.features;
      } else {
        batch = JSON.parse("[" + text.slice(start, cut) + "]");
      }
    } catch {
      return JSON.parse(text);
    }
    for (const feature of batch) features.push(feature);
    if (tail) {
      tail.features = features;
      return tail;
    }
    start = cut + 1;
    await nextTask();
    if (!current()) return null;
  }
}
