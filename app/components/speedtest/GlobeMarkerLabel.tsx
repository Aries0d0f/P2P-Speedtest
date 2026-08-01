import type { LabelPlacement } from "~/model/globe.model";
import type { PeerView } from "~/model/presentation.model";

export function MarkerLabel({
  ref,
  name,
  peer,
  present,
  type,
}: {
  ref: React.Ref<HTMLDivElement>;
  name: string;
  peer: PeerView;
  present: boolean;
  type: "local" | "remote";
}) {
  if (!present) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`flex flex-col gap-1 backdrop-blur-xs pointer-events-none absolute left-0 top-0 hidden ${type === "local" ? "-translate-x-1/2 text-right" : "translate-x-1/2 text-left"} -translate-y-[0.5rem] whitespace-nowrap rounded-lg bg-white/85 px-2 py-0.5 font-medium text-gray-900 shadow-sm dark:bg-gray-900/85 dark:text-gray-100`}
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
) {
  if (!element) return;
  if (!placement || !placement.visible) {
    element.style.display = "none";
    return;
  }
  element.style.display = "flex";
  element.style.transform = `translate(${placement.x}px, ${placement.y}px) translate(-50%, -140%)`;
}
