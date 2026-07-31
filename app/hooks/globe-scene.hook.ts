import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { buildFrame } from "~/lib/globe-frame";
import { qualityForWidth } from "~/components/speedtest/three/globe-scene";
import type {
  GlobeScene,
  GlobeSceneFactory,
  LabelPlacements,
  QualityTier,
} from "~/model/globe.model";
import type { LiveTestPresentation } from "~/model/presentation.model";
import type { ElementBox } from "./element-box.hook";

export interface GlobeSceneRefs {
  canvas: RefObject<HTMLCanvasElement | null>;
  /** The in-flow placeholder: the reference box for the globe's pixel size and
   * the style host the theme colours are read from. */
  placeholder: RefObject<Element | null>;
}

export interface GlobeSceneOpts {
  factory: GlobeSceneFactory;
  /** The fixed layer's box — drives the renderer and camera aspect. */
  box: ElementBox;
  /** The placeholder's box — drives the globe's pixel size, the quality tier
   * and the desktop/mobile orientation contract, so all three stay keyed to
   * the page's own responsive layout rather than to the viewport. */
  reference: ElementBox;
  reducedMotion: boolean;
  documentVisible: boolean;
  /** Called every frame with the projected label positions. */
  onLabels?: (placements: LabelPlacements) => void;
  onVisualError?: (error: unknown) => void;
}

/**
 * Owns exactly one renderer for the life of the component.
 *
 * The cleanup disposes it even under StrictMode's mount/unmount/remount, where
 * a scene that resolves *after* unmount must be disposed rather than leak a
 * WebGL context. A failure inside one run is sticky, so a broken driver is not
 * retried four times a second; a new run clears it.
 */
export function useGlobeScene(
  refs: GlobeSceneRefs,
  presentation: LiveTestPresentation,
  opts: GlobeSceneOpts,
): { failed: boolean } {
  const { factory, box, reference, reducedMotion, documentVisible, onVisualError } = opts;

  const sceneRef = useRef<GlobeScene | null>(null);
  const failedRef = useRef(false);
  const [failed, setFailed] = useState(false);

  // Fixed for the life of the scene: rebuilding a point cloud mid-resize would
  // cost far more than the dots it saves. Orientation still tracks the
  // container width every frame.
  const qualityRef = useRef<QualityTier | null>(null);

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

  const runId = presentation.runId;
  useEffect(() => {
    failedRef.current = false;
    setFailed(false);
  }, [runId]);

  const applyLabels = useCallback(
    (placements: LabelPlacements) => opts.onLabels?.(placements),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const hasBox = box.width > 0 && box.height > 0 && reference.height > 0;

  useEffect(() => {
    if (!hasBox || failed || sceneRef.current) return;
    const canvas = refs.canvas.current;
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
        scene.update(
          buildFrame(presentation, reference.width, reducedMotion, refs.placeholder.current),
        );
        scene.setActive(documentVisible);
      })
      .catch(reportFailure);

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // `presentation`, `reducedMotion` and `documentVisible` are read for the
    // first frame only; the effects below keep the scene current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBox, failed, factory, applyLabels, reportFailure]);

  useEffect(() => {
    if (!hasBox) return;
    sceneRef.current?.resize(box.width, box.height, reference.height);
  }, [hasBox, box.width, box.height, reference.height]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !hasBox) return;
    try {
      scene.update(
        buildFrame(presentation, reference.width, reducedMotion, refs.placeholder.current),
      );
    } catch (error) {
      reportFailure(error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation, reference.width, hasBox, reducedMotion, reportFailure]);

  useEffect(() => {
    sceneRef.current?.setActive(documentVisible);
  }, [documentVisible]);

  return { failed };
}
