import type { LabelPlacement, LabelPlacements } from "~/model/globe.model";
import type { PeerView } from "~/model/presentation.model";

/** Which side of its own marker a label hangs off. The pair always takes
 * opposite sides, so the two never stack on the same point. */
export type LabelSide = "left" | "right";

export interface LabelSides {
  local: LabelSide;
  remote: LabelSide;
}

/** Neither marker is on screen yet, so the pair starts already separated. */
export const INITIAL_SIDES: LabelSides = { local: "left", remote: "right" };

/** Horizontal clearance between a marker and its label, in CSS pixels. */
const GAP = 8;

/**
 * How far apart the markers must be, in CSS pixels, before the pair is allowed
 * to swap sides. Without a band the labels flip on every frame while the globe
 * carries one marker across the other.
 */
const FLIP_MARGIN = 24;

/**
 * Which way each label should face, given where the two markers currently
 * project. Each label hangs away from the other marker, so the gap between them
 * is the widest the geometry allows.
 *
 * Returns `current` unchanged — by identity, so the caller can skip a render —
 * whenever the answer has not changed, including while a marker is hidden or
 * the two are inside the flip margin.
 */
export function sidesFor(placements: LabelPlacements, current: LabelSides): LabelSides {
  const { local, remote } = placements;
  // One marker behind the globe can't overlap the other, and its own side is
  // whatever it had — flipping an invisible label only causes a flicker when it
  // comes back around.
  if (!local?.visible || !remote?.visible) return current;

  const offset = local.x - remote.x;
  if (Math.abs(offset) < FLIP_MARGIN) return current;

  const localSide: LabelSide = offset < 0 ? "left" : "right";
  if (localSide === current.local) return current;
  return { local: localSide, remote: localSide === "left" ? "right" : "left" };
}

export function MarkerLabel({
  ref,
  name,
  peer,
  present,
  position,
}: {
  ref: React.Ref<HTMLDivElement>;
  name: string;
  peer: PeerView;
  present: boolean;
  position: LabelSide;
}) {
  if (!present) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid={`marker-label-${position}`}
      /* The offset itself lives in `placeLabel`'s transform, which would
         override any translate utility written here. */
      className={`flex flex-col gap-1 backdrop-blur-xs pointer-events-none absolute left-0 top-0 hidden ${position === "left" ? "text-right" : "text-left"} whitespace-nowrap rounded-lg bg-white/85 px-2 py-0.5 font-medium text-gray-900 shadow-sm dark:bg-gray-900/85 dark:text-gray-100`}
    >
      <span className="text-sm">{name}</span>
      <span className={peer.protocol === "IPv6" ? "text-tiny" : "text-xs"}>
        {peer.ip}
      </span>
    </div>
  );
}

/** Written straight to the element every frame — deliberately not React
 * state, which would re-render the whole dashboard at 60 Hz. */
export function placeLabel(
  element: HTMLDivElement | null,
  placement: LabelPlacement | null,
  side: LabelSide,
) {
  if (!element) return;
  if (!placement || !placement.visible) {
    element.style.display = "none";
    return;
  }
  element.style.display = "flex";
  // A left label ends at its marker, a right one starts there, so the pair
  // opens outward instead of both straddling their own points.
  const anchor =
    side === "left" ? `translate(calc(-100% - ${GAP}px), -140%)` : `translate(${GAP}px, -140%)`;
  element.style.transform = `translate(${placement.x}px, ${placement.y}px) ${anchor}`;
}
