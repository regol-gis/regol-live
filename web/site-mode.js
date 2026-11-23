const site = new URL(import.meta.url);
export const hostedPages = site.hostname === "live.regol.org" ||
  (site.hostname === "regol-gis.github.io" && site.pathname.startsWith("/regol-live/"));
export const parentsOfMessage = "Finding parent ways or relations requires the local server. Run this query with regol live.";

export function checkParentLookups(sets) {
  if (sets?.some(set => ["bn", "bw", "br"].includes(set.membership?.direction) ||
      set.filters?.some(filter => filter.predicate === "parents_of"))) {
    throw Error(parentsOfMessage);
  }
}
