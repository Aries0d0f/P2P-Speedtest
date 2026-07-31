/** The one Mbps formatter shared by the gauge and the graph: precision falls
 * away as the number grows, so the readout keeps a stable width. */
export function formatMbps(mbps: number): string {
  if (mbps >= 100) return mbps.toFixed(0);
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
}
