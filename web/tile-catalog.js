const page = 4096;
const segment = 2 ** 30;
const maxDirectory = 1024 * 1024;
const maxTiles = 32;

export class UnsupportedCatalog extends Error {}

export class TileCountLimit extends UnsupportedCatalog {
  constructor(limit) {
    super(`This view covers more than ${limit} tiles. Zoom in to download a smaller area.`);
  }
}

function check(condition) {
  if (!condition) throw new UnsupportedCatalog("Could not read the GOL tile directory or extents.");
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function readCatalog(read, size) {
  const header = view(await read(0, 256));
  check(
    header.getUint32(0, true) === 0x1ce50d6e && header.getUint32(4, true) === 2,
  );
  const active = header.getUint8(16);
  check(active <= 1);
  const metadataEnd = page + header.getUint32(20, true);
  const base = page * header.getUint32(128 + active * 64 + 24, true);
  check(
    metadataEnd <= 16 * 1024 * 1024 && metadataEnd <= base && base + 4 <= size,
  );
  const length = view(await read(base, 4)).getUint32(0, true);
  check(length >= 4 && length % 4 === 0 && length <= maxDirectory);
  const end = base + 4 + length;
  check(end <= size);
  check(Math.floor(base / segment) === Math.floor((end - 1) / segment));
  const bits = header.getUint32(96, true);
  check(bits & 1 && !(bits & ~0x1fff));
  const zooms = [];
  for (let z = 0; z <= 12; z++) {
    if (bits & (1 << z)) {
      check(!zooms.length || z - zooms.at(-1) <= 3);
      zooms.push(z);
    }
  }
  return {
    bytes: view(await read(base + 4, length)),
    zooms,
    metadataEnd,
    directory: [base, end],
  };
}

// Coordinates in the compact directory are Web Mercator slippy-map tile numbers.
export function projectedBox(value, regionalOnly = true) {
  const fields = value?.split(",");
  if (fields?.length !== 4 || fields.some((x) => !x.trim())) return;
  const [w, s, e, n] = fields.map(Number);
  if (!(w >= -180 && w < e && e <= 180 && s >= -90 && s < n && n <= 90)) return;
  // Prefetch only regional views. Broad queries keep the demand reader.
  if (regionalOnly && (e - w > 4 || n - s > 4)) return;
  const y = (lat) => {
    const rad =
      (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
    return (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2;
  };
  return [(w + 180) / 360, y(n), (e + 180) / 360, y(s)];
}

export function tileStarts({ bytes, zooms }, [west, north, east, south], limit = maxTiles, onTile) {
  const tiles = new Map();
  function visit(entry, level, col, row) {
    const zoom = zooms[level];
    const scale = 2 ** zoom;
    if (
      col > east * scale ||
      col + 1 < west * scale ||
      row > south * scale ||
      row + 1 < north * scale
    )
      return;
    let word = bytes.getUint32(entry, true);
    const branch = (word & 3) === 1;
    if (branch) {
      entry += word & ~3; // Signed byte displacement from this index entry.
      word = bytes.getUint32(entry, true);
    }
    check((word & 3) === 2 && word >>> 2 > 0);
    const start = (word >>> 2) * page;
    check(!tiles.has(start));
    if (tiles.size >= limit)
      throw new TileCountLimit(limit);
    tiles.set(start, zoom);
    onTile?.(start, entry);
    if (!branch && level !== 0) return;
    if (level + 1 === zooms.length) {
      check(!branch);
      return;
    }
    const width = 2 ** (zooms[level + 1] - zoom);
    const wide = width === 8;
    const mask = wide
      ? bytes.getBigUint64(entry + 4, true)
      : BigInt(bytes.getUint32(entry + 4, true));
    check(mask >> BigInt(width * width) === 0n);
    let child = entry + (wide ? 12 : 8);
    for (let i = 0; i < width * width; i++) {
      if (mask & (1n << BigInt(i))) {
        visit(
          child,
          level + 1,
          col * width + (i % width),
          row * width + Math.floor(i / width),
        );
        child += 4;
      }
    }
  }
  visit(0, 0, 0, 0);
  return tiles;
}

export function tileEnd({ metadataEnd, directory }, size, start, header) {
  check(start >= metadataEnd && start + 4 <= size);
  const payload = view(header).getUint32(0, true) & 0x3fff_ffff;
  const end = start + 4 + payload;
  check(payload >= 28 && end <= size);
  check(Math.floor(start / segment) === Math.floor((end - 1) / segment));
  check(end <= directory[0] || start >= directory[1]);
  return end;
}
