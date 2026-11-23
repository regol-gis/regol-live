// Charge whole query payloads, even when adjacent views share most features.
const maxViews = 6;
const maxEntries = 100_000;
const maxBytes = 64 * 1024 * 1024;

export const featureKey = (feature) => feature.properties?.fid ?? feature.id;
const fingerprint = ({ sets, show, output, outputs, queryText }) =>
  queryText ?? JSON.stringify([sets, show, output, outputs]);

export class DisplayCache {
  views = [];
  byId = new Map();
  snapshot = null;

  constructor(url, request) {
    this.url = url;
    this.program = fingerprint(request);
    this.geometry = request.geometry;
    this.viewDependent = request.sets.some((set) =>
      set.control || set.membership || set.recurse || set.difference?.length || set.intersect?.length ||
      set.overpass?.area || set.overpass?.around?.reference ||
      set.filters?.some((f) => f.reference && f.reference !== "geometry"),
    );
  }

  matches(url, request) {
    return (
      this.url === url &&
      this.program === fingerprint(request) &&
      this.geometry === request.geometry
    );
  }

  recall(windows) {
    if (this.viewDependent) return null;
    const key = JSON.stringify(windows);
    const index = this.views.findIndex(
      (view) => view.key === key && view.complete,
    );
    if (index < 0) return null;
    const [view] = this.views.splice(index, 1);
    this.views.unshift(view);
    return view;
  }

  store(
    windows,
    {
      features,
      counts,
      outputs,
      resultBytes,
      snapshot,
      limited,
      skippedGeometries,
      skippedReferences,
      setStats,
    },
  ) {
    const sameSnapshot = this.snapshot === snapshot;
    const key = JSON.stringify(windows);
    const current = {
      key,
      bytes: resultBytes,
      complete: !limited,
      counts,
      outputs,
      skippedGeometries,
      skippedReferences,
      setStats,
      features: sameSnapshot
        ? features.map((f) => {
            const prior = this.byId.get(featureKey(f));
            return prior && prior.properties?.group === f.properties?.group
              ? prior
              : f;
          })
        : features,
    };
    const retained = [current];
    let entries = features.length,
      bytes = resultBytes;
    // A reference selector is evaluated within the new viewport. Even a shared
    // feature can stop matching (including for disjoint or distance queries).
    if (sameSnapshot && current.complete && !this.viewDependent) {
      for (const view of this.views) {
        if (view.key === key || !view.complete) continue;
        entries += view.features.length;
        bytes += view.bytes;
        if (
          retained.length === maxViews ||
          entries > maxEntries ||
          bytes > maxBytes
        )
          break;
        retained.push(view);
      }
    }
    this.snapshot = snapshot;
    this.views = retained;
    this.byId = new Map();
    for (const view of retained)
      for (const feature of view.features) this.byId.set(featureKey(feature), feature);
    return current;
  }
}
