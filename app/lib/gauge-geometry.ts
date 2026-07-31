/** Pure SVG geometry for the speed gauge. */

export const START_ANGLE = -220; // degrees, measured clockwise from 12 o'clock
export const SWEEP = 260;
export const RADIUS = 54;
export const CENTER = 64;

/** Fraction of full scale, clamped. */
export function fraction(mbps: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return Math.min(1, Math.max(0, mbps / ceiling));
}

export function angleFor(value: number): number {
  return START_ANGLE + value * SWEEP;
}

export function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(radians), y: CENTER + radius * Math.sin(radians) };
}

export function arcPath(fromValue: number, toValue: number, radius: number): string {
  const from = polar(angleFor(fromValue), radius);
  const to = polar(angleFor(toValue), radius);
  const large = (toValue - fromValue) * SWEEP > 180 ? 1 : 0;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

export const TRACK_PATH = arcPath(0, 1, RADIUS);

/** Arc length in user units, for the dash-offset draw. */
export function arcLengthFor(radius: number): number {
  return SWEEP * (Math.PI / 180) * radius;
}
