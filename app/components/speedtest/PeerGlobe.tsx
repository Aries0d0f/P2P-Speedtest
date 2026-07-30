import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { LiveTestPresentation, TransferToken } from "~/lib/test-visualization";

import {
  layoutForWidth,
  qualityForWidth,
  type GlobeFrame,
  type GlobeScene,
  type GlobeSceneFactory,
  type LabelPlacements,
  type QualityTier,
} from "./three/globe-scene";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * The peer globe (06-live-test-visualization 6.2, 6.3).
 *
 * React owns exactly one renderer and one `ResizeObserver` here, and the
 * effect's cleanup disposes both — including under StrictMode's
 * mount/unmount/remount, where an async scene that resolves after unmount is
 * disposed immediately rather than leaking a WebGL context.
 *
 * The canvas is decorative: everything it shows also exists as text, either in
 * the DOM labels beside it or in the dashboard's summary. Any failure —
 * rejected chunk, missing WebGL 2, lost context, throw inside the render loop
 * — replaces this component's own content and is reported upward, but never
 * touches the room state machine.
 */

/** Fallbacks used before the stylesheet resolves and in non-browser tests.
 * The live values come from `app.css`, which is the single definition. */
const FALLBACK_COLORS: Record<TransferToken, number> = {
  "--transfer-receive": 0x22d3ee,
  "--transfer-send": 0xa78bfa,
  "--transfer-duplex": 0x34d399,
  "--transfer-idle": 0x64748b,
};

const PEER_MARKER_COLOR = 0xf8fafc;

function parseCssColor(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((c) => c + c)
            .join("")
        : digits;
    return Number.parseInt(full, 16);
  }
  // `getComputedStyle` normalises most authored colours to rgb()/rgba().
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (!rgb) return null;
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((n) => Math.round(Number.parseFloat(n)));
  if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return null;
  return (r << 16) | (g << 8) | b;
}

/** Reads a semantic transfer colour from the cascade so the scene follows the
 * light/dark theme instead of hard-coding a second palette. */
function readToken(element: Element | null, token: TransferToken): number {
  if (!element || typeof getComputedStyle !== "function") return FALLBACK_COLORS[token];
  const value = getComputedStyle(element).getPropertyValue(token);
  return parseCssColor(value) ?? FALLBACK_COLORS[token];
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => setVisible(!document.hidden);
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);
  return visible;
}

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

const defaultFactory: GlobeSceneFactory = async (options) => {
  const module = await import("./three/create-globe-scene");
  return module.createGlobeScene(options);
};

export function PeerGlobe({ presentation, createScene, onVisualError }: PeerGlobeProps) {
  // The in-flow element that reserves the globe's layout space. It is also
  // the reference box: the globe is drawn at the pixel size it would have had
  // here, so going full-screen surrounds it with space rather than magnifying
  // it. And it is the style host the theme colours are read from.
  const placeholderRef = useRef<HTMLDivElement>(null);
  // The fixed, viewport-sized layer the canvas and its labels live in.
  const layerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const localLabelRef = useRef<HTMLDivElement>(null);
  const remoteLabelRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);

  const [box, setBox] = useState({ width: 0, height: 0 });
  const [reference, setReference] = useState({ width: 0, height: 0 });
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const documentVisible = useDocumentVisible();

  // The tier is fixed for the life of the scene: rebuilding a point cloud
  // mid-resize would cost far more than the few thousand dots it saves, and a
  // dragged window would thrash the GPU. Orientation still tracks the
  // container width every frame.
  const qualityRef = useRef<QualityTier | null>(null);

  const failedRef = useRef(false);
  const reportFailure = useCallback(
    (error: unknown) => {
      if (failedRef.current) return;
      failedRef.current = true;
      console.warn("peer globe failed", error);
      sceneRef.current?.dispose();
      sceneRef.current = null;
      setFailed(true);
      onVisualError?.(error);
    },
    [onVisualError],
  );

  // A new run clears a previous run's failure; a failure inside one run is
  // sticky, so a broken driver is not retried four times a second.
  const runId = presentation.runId;
  useEffect(() => {
    failedRef.current = false;
    setFailed(false);
  }, [runId]);

  const applyLabels = useCallback((placements: LabelPlacements) => {
    place(localLabelRef.current, placements.local);
    place(remoteLabelRef.current, placements.remote);
  }, []);

  // --- portal host ----------------------------------------------------------
  /*
   * The globe layer is `position: fixed`, which makes it a *positioned*
   * element. Positioned elements paint after every non-positioned block in
   * their stacking context, so wherever it sits inside the page it would
   * cover the content — and a negative z-index does not rescue it, because
   * `body`'s own background paints later still and hides it entirely.
   *
   * So the layer is portalled to the front of `<body>` instead, and the route
   * marks its `<main>` `relative`. Both are then positioned elements with
   * `z-index: auto`, and plain document order decides: the layer is first, so
   * everything paints on top of it. No z-index anywhere.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const host = document.createElement("div");
    host.dataset.globeLayerHost = "";
    // `insertBefore(…, firstChild)` rather than `prepend`: the Workers runtime
    // types in this project declare their own `Element.prepend` (HTMLRewriter's),
    // which shadows the DOM signature.
    document.body.insertBefore(host, document.body.firstChild);
    setPortalHost(host);

    // The route's `<main>` must be positioned or it paints *below* this
    // layer and the page disappears. That coupling is invisible from here, so
    // say so loudly in development rather than leaving someone to debug a
    // blank screen. Stripped from production builds.
    if (import.meta.env.DEV) {
      const main = document.querySelector("main");
      if (main && getComputedStyle(main).position === "static") {
        console.warn(
          "PeerGlobe: <main> is position:static, so the globe layer will cover the page. " +
            'Add "relative" to the route\'s <main> class list.',
        );
      }
    }

    return () => {
      host.remove();
      setPortalHost(null);
    };
  }, []);

  // --- measure -------------------------------------------------------------
  // Two boxes, one observer. The layer drives the renderer and camera aspect;
  // the placeholder drives the globe's pixel size, the quality tier, and the
  // desktop/mobile orientation contract — all of which must stay keyed to the
  // page's own responsive layout rather than to the viewport the canvas now
  // happens to fill.
  useEffect(() => {
    const placeholder = placeholderRef.current;
    const layer = layerRef.current;
    if (!placeholder || typeof ResizeObserver !== "function") return;

    const apply = (
      set: typeof setBox,
      rect: { width: number; height: number },
    ) =>
      set((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === placeholder) apply(setReference, entry.contentRect);
        else apply(setBox, entry.contentRect);
      }
    });
    observer.observe(placeholder);
    apply(setReference, placeholder.getBoundingClientRect());
    if (layer) {
      observer.observe(layer);
      apply(setBox, layer.getBoundingClientRect());
    }
    return () => observer.disconnect();
    // `portalHost` gates the layer's existence, so re-measure once it lands.
  }, [portalHost]);

  // --- create ---------------------------------------------------------------
  const factory = createScene ?? defaultFactory;
  const hasBox = box.width > 0 && box.height > 0 && reference.height > 0;
  useEffect(() => {
    if (!hasBox || failed || sceneRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (qualityRef.current === null) qualityRef.current = qualityForWidth(reference.width);
    let cancelled = false;

    void factory({
      canvas,
      quality: qualityRef.current,
      onLabels: applyLabels,
      onError: reportFailure,
    })
      .then((scene) => {
        if (cancelled || failedRef.current) {
          // StrictMode's synthetic unmount, or a failure raised while the
          // chunk was still loading: dispose rather than leak a context.
          scene.dispose();
          return;
        }
        sceneRef.current = scene;
        scene.resize(box.width, box.height, reference.height);
        scene.update(buildFrame(presentation, reference.width, reducedMotion, placeholderRef.current));
        scene.setActive(documentVisible);
      })
      .catch(reportFailure);

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // `presentation`, `reducedMotion` and `documentVisible` are read for the
    // first frame only; their own effects below keep the scene current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBox, failed, factory, applyLabels, reportFailure]);

  // --- keep current ---------------------------------------------------------
  useEffect(() => {
    if (!hasBox) return;
    sceneRef.current?.resize(box.width, box.height, reference.height);
  }, [hasBox, box.width, box.height, reference.height]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !hasBox) return;
    try {
      scene.update(buildFrame(presentation, reference.width, reducedMotion, placeholderRef.current));
    } catch (error) {
      reportFailure(error);
    }
  }, [presentation, reference.width, hasBox, reducedMotion, reportFailure]);

  useEffect(() => {
    sceneRef.current?.setActive(documentVisible);
  }, [documentVisible]);

  const { localPeer, remotePeer } = presentation;

  if (failed) {
    return (
      <div
        ref={placeholderRef}
        data-testid="peer-globe"
        className="surface-panel relative flex min-h-[12rem] w-full items-center justify-center rounded-2xl border border-dashed border-gray-300 p-4 text-center dark:border-gray-700"
      >
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The globe couldn't be shown on this device. Every measurement below is unaffected.
        </p>
      </div>
    );
  }

  return (
    <>
      {/*
        Placeholder. The canvas is out of flow, so without this the page would
        collapse over the globe. Its box is exactly the one the canvas used to
        occupy, which is what keeps the surrounding layout — and the globe's
        own apparent size — unchanged.
      */}
      <div
        ref={placeholderRef}
        data-testid="peer-globe"
        aria-hidden="true"
        className="pointer-events-none aspect-square w-full sm:aspect-[4/3]"
      />

      {/*
        The immersive layer: viewport-sized, fixed, and first in the document
        so the page paints over it by document order alone.
        `pointer-events-none` keeps it from swallowing a click meant for the
        Cancel button.
      */}
      {portalHost !== null &&
        createPortal(
          <div
            ref={layerRef}
            data-testid="peer-globe-layer"
            className="pointer-events-none fixed inset-0 overflow-hidden"
          >
            {/* Decorative: peers, locations, direction and speed all exist as text. */}
            <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
            <MarkerLabel
              ref={localLabelRef}
              name={`${localPeer.name} (you)`}
              present={localPeer.location !== null}
            />
            <MarkerLabel ref={remoteLabelRef} name={remotePeer.name} present={remotePeer.location !== null} />
          </div>,
          portalHost,
        )}
    </>
  );
}

function MarkerLabel({
  ref,
  name,
  present,
}: {
  ref: React.Ref<HTMLDivElement>;
  name: string;
  present: boolean;
}) {
  if (!present) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 hidden -translate-x-1/2 -translate-y-[calc(100%+0.5rem)] whitespace-nowrap rounded-full bg-white/85 px-2 py-0.5 text-[11px] font-medium text-gray-900 shadow-sm dark:bg-gray-900/85 dark:text-gray-100"
    >
      {name}
    </div>
  );
}

/** Written straight to the element every frame — deliberately not React
 * state, which would re-render the whole dashboard at 60 Hz. */
function place(element: HTMLDivElement | null, placement: { x: number; y: number; visible: boolean } | null) {
  if (!element) return;
  if (!placement || !placement.visible) {
    element.style.display = "none";
    return;
  }
  element.style.display = "block";
  element.style.transform = `translate(${placement.x}px, ${placement.y}px) translate(-50%, -140%)`;
}

/**
 * The immutable frame handed to the scene. Every animated value in it comes
 * from the presentation selector; nothing is read back out of the scene.
 */
export function buildFrame(
  presentation: LiveTestPresentation,
  width: number,
  reducedMotion: boolean,
  styleHost: Element | null,
): GlobeFrame {
  const idle = readToken(styleHost, "--transfer-idle");
  const routeColor =
    presentation.mode === "idle"
      ? idle
      : readToken(
          styleHost,
          presentation.mode === "duplex"
            ? "--transfer-duplex"
            : presentation.mode === "receive"
              ? "--transfer-receive"
              : "--transfer-send",
        );

  return {
    layout: layoutForWidth(width),
    localLocation: presentation.localPeer.location,
    remoteLocation: presentation.remotePeer.location,
    routeColor,
    localColor: PEER_MARKER_COLOR,
    remoteColor: PEER_MARKER_COLOR,
    streams: presentation.channels.map((channel) => ({
      key: channel.key,
      // Physical direction, identical on both peers' screens.
      fromLocal: channel.senderSlot === presentation.localPeer.slot,
      mbps: channel.mbps,
      color: readToken(styleHost, channel.token),
    })),
    reducedMotion,
    running: presentation.active && presentation.mode !== "idle",
  };
}
