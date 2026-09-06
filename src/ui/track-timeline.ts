/** The common clock continues; each track's visual position stops at its own edges. */
export function trackTimelineRatio(positionUs: number, startUs: number, endUs: number, durationUs: number) {
  return Math.max(0, Math.min(1, Math.max(startUs, Math.min(endUs, positionUs)) / Math.max(1, durationUs)));
}
