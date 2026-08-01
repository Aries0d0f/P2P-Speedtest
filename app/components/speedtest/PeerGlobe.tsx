import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useDocumentVisible } from "~/hooks/document-visible.hook";
import { useElementBoxes } from "~/hooks/element-box.hook";
import { useGlobeScene } from "~/hooks/globe-scene.hook";
import { usePortalHost } from "~/hooks/portal-host.hook";
import { usePrefersReducedMotion } from "~/hooks/reduced-motion.hook";
import type { GlobeSceneFactory, LabelPlacements } from "~/model/globe.model";
import type { LiveTestPresentation } from "~/model/presentation.model";

import { INITIAL_SIDES, MarkerLabel, placeLabel, sidesFor } from "./GlobeMarkerLabel";

/**
 * The peer globe (6.2, 6.3).
 *
 * The canvas is decorative: everything it shows also exists as text, either in
 * the DOM labels beside it or in the dashboard's summary. Any failure —
 * rejected chunk, missing WebGL 2, lost context, throw inside the render loop —
 * replaces this component's own content and is reported upward, but never
 * touches the room state machine.
 */

export interface PeerGlobeProps {
  presentation: LiveTestPresentation;
  /**
   * Seam for tests and the development harness. Production passes nothing and
   * gets the dynamically imported Three.js scene, so the WebGL chunk is only
   * fetched by the routes that actually mount this component.
   */
  createScene?: GlobeSceneFactory;
  /** Reported once per failure; the caller decides what to show instead. */
  onVisualError?: (error: unknown) => void;
}

const MAIN_STATIC_WARNING =
  "PeerGlobe: <main> is position:static, so the globe layer will cover the page. " +
  'Add "relative" to the route\'s <main> class list.';

const defaultFactory: GlobeSceneFactory = async (options) => {
  const module = await import("./three/create-globe-scene");
  return module.createGlobeScene(options);
};

export function PeerGlobe({
  presentation,
  createScene,
  onVisualError,
}: PeerGlobeProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const localLabelRef = useRef<HTMLDivElement>(null);
  const remoteLabelRef = useRef<HTMLDivElement>(null);

  const reducedMotion = usePrefersReducedMotion();
  const documentVisible = useDocumentVisible();
  const portalHost = usePortalHost(
    "data-globe-layer-host",
    MAIN_STATIC_WARNING,
  );
  // `portalHost` gates the layer's existence, so re-measure once it lands.
  const [reference, box] = useElementBoxes(
    [placeholderRef, layerRef],
    portalHost,
  );

  // Which way the labels face is the one part of their placement React owns:
  // it decides Tailwind classes, and it changes a handful of times per
  // rotation rather than every frame. `sidesFor` returns the same object while
  // the answer holds, so the common frame does no work at all.
  const [sides, setSides] = useState(INITIAL_SIDES);
  const sidesRef = useRef(sides);

  const applyLabels = useCallback((placements: LabelPlacements) => {
    const next = sidesFor(placements, sidesRef.current);
    if (next !== sidesRef.current) {
      sidesRef.current = next;
      setSides(next);
    }
    placeLabel(localLabelRef.current, placements.local, next.local);
    placeLabel(remoteLabelRef.current, placements.remote, next.remote);
  }, []);

  const { failed } = useGlobeScene(
    { canvas: canvasRef, placeholder: placeholderRef },
    presentation,
    {
      factory: createScene ?? defaultFactory,
      box,
      reference,
      reducedMotion,
      documentVisible,
      onLabels: applyLabels,
      onVisualError,
    },
  );

  const { localPeer, remotePeer } = presentation;

  if (failed) {
    return (
      <div
        ref={placeholderRef}
        data-testid="peer-globe"
        className="surface-panel relative flex min-h-[12rem] w-full items-center justify-center rounded-2xl border border-dashed border-gray-300 p-4 text-center dark:border-gray-700"
      >
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The globe couldn't be shown on this device. Every measurement below is
          unaffected.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Reserves exactly the box the canvas used to occupy, so the page does
          not collapse over the out-of-flow globe. */}
      <div
        ref={placeholderRef}
        data-testid="peer-globe"
        aria-hidden="true"
        className="pointer-events-none aspect-square w-full"
      />

      {/* `pointer-events-none` keeps the layer from swallowing a click meant
          for the Cancel button. */}
      {portalHost !== null &&
        createPortal(
          <div
            ref={layerRef}
            data-testid="peer-globe-layer"
            className="pointer-events-none fixed inset-0 overflow-hidden"
          >
            {/* Decorative: peers, locations, direction and speed all exist as text. */}
            <canvas
              ref={canvasRef}
              aria-hidden="true"
              className="block h-full w-full"
            />
            <MarkerLabel
              ref={localLabelRef}
              name={`${localPeer.name} (You)`}
              peer={localPeer}
              present={localPeer.location !== null}
              position={sides.local}
            />
            <MarkerLabel
              ref={remoteLabelRef}
              name={remotePeer.name}
              peer={remotePeer}
              present={remotePeer.location !== null}
              position={sides.remote}
            />
          </div>,
          portalHost,
        )}
    </>
  );
}
