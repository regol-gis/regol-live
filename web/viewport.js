export function insideDownloadedArea(download, view) {
  if (!download?.length || !view?.length) return false;
  // Both views are split at the antimeridian. Allow sub-millimetre camera rounding.
  const epsilon = 1e-9;
  return view.every(([w, s, e, n]) => download.some(([west, south, east, north]) =>
    w >= west - epsilon && s >= south - epsilon && e <= east + epsilon && n <= north + epsilon));
}

// MapLibre may return repeated worlds outside [-180, 180].
export function windows(west, south, east, north) {
  south = Math.max(-90, south);
  north = Math.min(90, north);
  const width = east - west;
  if (width >= 360) return [[-180, south, 180, north]];
  const start = ((((west + 180) % 360) + 360) % 360) - 180;
  const end = start + width;
  return end <= 180
    ? [[start, south, end, north]]
    : [
        [start, south, 180, north],
        [-180, south, end - 360, north],
      ];
}

// Wrapped selections have two query boxes but no border at the date line.
export function downloadOutline(bounds) {
  if (!bounds?.length) return null;
  const wrapped = bounds.length === 2 && bounds[0][2] === 180 && bounds[1][0] === -180;
  const coordinates = bounds.map(([w, s, e, n], i) => {
    if (wrapped) return i === 0
      ? [[e, n], [w, n], [w, s], [e, s]]
      : [[w, s], [e, s], [e, n], [w, n]];
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  });
  return { type: "MultiLineString", coordinates };
}
