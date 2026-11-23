const root = "https://download.openplanetdata.com/osm/planet/";
const paths = { gol: root + "gol/v2/", gob: root + "gob/v1/" };
export const planetURL = paths.gol + "planet-latest.osm.gol";
export const planetGobURL = paths.gob + "planet-latest.osm.gob";
export const planetCatalogURL = "https://download.openplanetdata.com/files?category=openstreetmap&subcategory=planet&limit=-1";

export function isPlanetFile(url, format) {
  if (typeof url !== "string" || !url.startsWith(paths[format])) return false;
  const file = url.slice(paths[format].length);
  return /^[\w./-]+$/.test(file) && !file.split("/").some(part => !part || part === "." || part === "..") &&
    file.endsWith(".osm." + format);
}

export function utcDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function selectPlanetFiles(files, now = Date.now()) {
  const today = utcDate(now);
  const first = utcDate(now - 6 * 86400000);
  const dates = { gol: new Map(), gob: new Map() };
  for (const file of files) {
    const format = file?.extension;
    if ((format !== "gol" && format !== "gob") || file.deprecated) continue;
    const url = `https://download.openplanetdata.com/${file.remote_path}/${file.remote_version}/${file.remote_filename}`;
    if (!isPlanetFile(url, format)) continue;
    const stamp = /(?:^|[^\d])(20\d\d)-?(\d\d)-?(\d\d)(?!\d)/.exec(url.slice(paths[format].length));
    const dated = stamp && stamp.slice(1).join("-");
    const date = dated || utcDate(file.updated);
    if (!date || utcDate(date) !== date || date > today) continue;
    const previous = dates[format].get(date);
    if (!previous || (dated && !previous.dated)) dates[format].set(date, { url, date, dated: Boolean(dated) });
  }
  const newest = format => [...dates[format].keys()].sort().reverse();
  const common = newest("gol").find(date => date >= first && dates.gob.has(date));
  const pick = (format, url) => dates[format].get(common ?? newest(format)[0]) ?? { url, date: null };
  return { gol: pick("gol", planetURL), gob: pick("gob", planetGobURL) };
}

export async function discoverPlanetFiles() {
  try {
    const response = await fetch(planetCatalogURL, { credentials: "omit", signal: AbortSignal.timeout(4000) });
    if (response.ok) return selectPlanetFiles((await response.json()).files);
  } catch {}
  return selectPlanetFiles([]);
}
