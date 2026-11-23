// The globe is the leftmost 168px of the 724 × 168 wordmark. Draw only its
// teal surface so the original outline, ermine collar and clasp stay in front.
const canvas = document.querySelector(".identity canvas");
const logo = document.querySelector(".identity img");
const motion = matchMedia("(prefers-reduced-motion: no-preference)");
const turnMs = 30_000;
let renderer, timer;

function readPixels(
  image,
  x = 0,
  y = 0,
  width = image.naturalWidth,
  height = image.naturalHeight,
) {
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const context = surface.getContext("2d");
  context.drawImage(image, -x, -y);
  return context.getImageData(0, 0, width, height);
}

async function prepareGlobe() {
  // Equirectangular Natural Earth 1:110m land in the original emblem's palette.
  const texture = new Image();
  texture.src = new URL("./regol-globe-texture.png", import.meta.url);
  await Promise.all([texture.decode(), logo.decode()]);
  const atlas = readPixels(texture);
  const frame = readPixels(logo, 28, 10, 112, 126);
  const pixels = frame.data;
  const surface = [];
  const tilt = (12 * Math.PI) / 180;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const i = 4 * (y * frame.width + x);
      const teal = Math.min(pixels[i + 1], pixels[i + 2]) - pixels[i];
      pixels[i + 3] *= Math.max(0, Math.min(1, (teal - 5) / 19));
      if (!pixels[i + 3]) continue;
      // Invert the orthographic projection once. Rotation then changes only
      // the longitude sampled from the atlas, even near the poles and horizon.
      const east = (x + 28.5 - 83.8) / 54;
      const north = (73.7 - y - 10.5) / 62;
      const front = Math.sqrt(Math.max(0, 1 - east * east - north * north));
      const lat = Math.asin(
        Math.max(
          -1,
          Math.min(1, north * Math.cos(tilt) + front * Math.sin(tilt)),
        ),
      );
      const lon = Math.atan2(
        east,
        front * Math.cos(tilt) - north * Math.sin(tilt),
      );
      const column =
        ((0.5 + lon / (2 * Math.PI) - 28 / 360 + 1) % 1) * atlas.width;
      const row = Math.min(
        atlas.height - 1,
        Math.floor((0.5 - lat / Math.PI) * atlas.height),
      );
      const light =
        0.91 + 0.09 * Math.max(0, 0.77 * front + 0.41 * north - 0.28 * east);
      surface.push({ i, column, rowStart: row * atlas.width * 4, light });
    }
  }
  const context = canvas.getContext("2d");
  const start = performance.now();
  return () => {
    const shift =
      (((performance.now() - start) % turnMs) / turnMs) * atlas.width;
    for (const { i, column, rowStart, light } of surface) {
      const u = (column + shift) % atlas.width;
      const left = Math.floor(u),
        fraction = u - left;
      const a = rowStart + 4 * left,
        b = rowStart + 4 * ((left + 1) % atlas.width);
      for (let c = 0; c < 3; c++)
        pixels[i + c] =
          light *
          (atlas.data[a + c] +
            fraction * (atlas.data[b + c] - atlas.data[a + c]));
    }
    context.putImageData(frame, 28, 10);
  };
}

async function syncMotion() {
  clearInterval(timer);
  timer = undefined;
  canvas.hidden = true;
  if (!motion.matches || document.hidden) return;
  try {
    renderer ??= prepareGlobe();
    const draw = await renderer;
    if (!motion.matches || document.hidden || timer !== undefined) return;
    draw();
    canvas.hidden = false;
    timer = setInterval(draw, 100);
  } catch {
    // The static wordmark also works when canvas or the texture is unavailable.
  }
}
motion.addEventListener("change", syncMotion);
document.addEventListener("visibilitychange", syncMotion);
syncMotion();
