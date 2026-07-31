import { Suspense, lazy, useMemo, useState } from "react";

import {
  LiveVisualizationBoundary,
  VisualizationPending,
} from "~/components/speedtest/LiveVisualizationBoundary";
import type { StageProgress } from "~/model/measurement.model";
import type { Slot } from "~/model/signaling.model";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type StageId } from "~/model/stage.model";
import { describePresentation, selectLiveTestPresentation } from "~/lib/presentation-selector";
import type { RoomPhase } from "~/model/room.model";
import type { LiveTestRoomView } from "~/model/presentation.model";

/**
 * Development-only fixture harness for the live visualization (6.6).
 *
 * Drives the real dashboard through both slots, all three stages and the
 * awkward geographic cases (date line, antipodal, shared location, one peer
 * hidden) without opening a room or moving a byte of test traffic.
 *
 * `app/routes.ts` only registers this path outside production builds.
 */

const LiveTestDashboard = lazy(() => import("~/components/speedtest/LiveTestDashboard"));

const PLACES: Record<string, { lat: number; lon: number } | null> = {
  Tokyo: { lat: 35.6762, lon: 139.6503 },
  Berlin: { lat: 52.52, lon: 13.405 },
  Sydney: { lat: -33.8688, lon: 151.2093 },
  "São Paulo": { lat: -23.5505, lon: -46.6333 },
  "Date line W (+179)": { lat: 10, lon: 179 },
  "Date line E (−179)": { lat: 10, lon: -179 },
  "Tokyo antipode": { lat: -35.6762, lon: -40.3497 },
  "North pole": { lat: 90, lon: 0 },
  "(not shared)": null,
};

const STAGES: Array<{ label: string; value: StageId | null }> = [
  { label: "latency warm-up", value: null },
  { label: "download", value: DOWNLOAD },
  { label: "upload", value: UPLOAD },
  { label: "duplex", value: DUPLEX },
];

const PHASES: RoomPhase[] = ["paired", "testing", "finalizing", "result"];

function progressFor(stageId: StageId | null, mbpsIn: number, mbpsOut: number) {
  if (stageId === null) return {};
  const snap = (receiverSlot: Slot, mbps: number): StageProgress => ({
    stageId,
    receiverSlot,
    elapsedMs: 4000,
    bytes: (mbps * 1_000_000 * 4) / 8,
    chunksSeen: 980,
    highestSeqPlusOne: 1000,
  });
  if (stageId === DUPLEX) {
    return { [edgeKey(DUPLEX, 0)]: snap(0, mbpsIn), [edgeKey(DUPLEX, 1)]: snap(1, mbpsOut) };
  }
  const receiver: Slot = stageId === DOWNLOAD ? 1 : 0;
  return { [edgeKey(stageId, receiver)]: snap(receiver, stageId === DOWNLOAD ? mbpsOut : mbpsIn) };
}

export default function DevLiveView() {
  const [localSlot, setLocalSlot] = useState<Slot>(0);
  const [stageId, setStageId] = useState<StageId | null>(DOWNLOAD);
  const [phase, setPhase] = useState<RoomPhase>("testing");
  const [localPlace, setLocalPlace] = useState("Tokyo");
  const [remotePlace, setRemotePlace] = useState("Berlin");
  const [mbpsIn, setMbpsIn] = useState(94);
  const [mbpsOut, setMbpsOut] = useState(38);
  const [hasProgress, setHasProgress] = useState(true);
  const [runId, setRunId] = useState("dev-run-1");
  const [forceFail, setForceFail] = useState(false);
  const [staleRun, setStaleRun] = useState(false);

  const presentation = useMemo(() => {
    const view: LiveTestRoomView = {
      runId,
      phase,
      stageId,
      stageProgress: {
        runId: staleRun ? "some-older-run" : runId,
        entries: hasProgress ? progressFor(stageId, mbpsIn, mbpsOut) : {},
      },
      liveLatency: { rttMs: 27.4, jitterMs: 1.8, sampleCount: 24 },
      latencyBaseline: undefined,
      connectionType: "DIRECT",
      selfProfile: { name: "Local peer", geo: PLACES[localPlace] ?? undefined },
      otherProfile: { name: "Remote peer", geo: PLACES[remotePlace] ?? undefined },
    };
    return selectLiveTestPresentation(view, localSlot);
  }, [runId, phase, stageId, staleRun, hasProgress, mbpsIn, mbpsOut, localPlace, remotePlace, localSlot]);

  return (
    <main className="relative mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Live visualization harness
        </h1>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Development only — not registered in production builds. No room, no signaling, no test
          traffic.
        </p>
      </header>

      <section className="grid gap-3 rounded-2xl border border-gray-200 p-4 text-sm sm:grid-cols-2 dark:border-gray-700">
        <Field label="This browser is">
          <select
            value={localSlot}
            onChange={(e) => setLocalSlot(Number(e.target.value) as Slot)}
            className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
          >
            <option value={0}>slot 0</option>
            <option value={1}>slot 1</option>
          </select>
        </Field>

        <Field label="Stage">
          <select
            value={String(stageId)}
            onChange={(e) => setStageId(e.target.value === "null" ? null : (Number(e.target.value) as StageId))}
            className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
          >
            {STAGES.map((s) => (
              <option key={s.label} value={String(s.value)}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Phase">
          <select
            value={phase}
            onChange={(e) => setPhase(e.target.value as RoomPhase)}
            className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
          >
            {PHASES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Run id">
          <div className="flex gap-2">
            <input
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
            />
            <button
              type="button"
              onClick={() => setRunId(`dev-run-${Math.floor(performance.now())}`)}
              className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600"
            >
              new run
            </button>
          </div>
        </Field>

        <Field label="This peer's location">
          <PlaceSelect value={localPlace} onChange={setLocalPlace} />
        </Field>
        <Field label="Other peer's location">
          <PlaceSelect value={remotePlace} onChange={setRemotePlace} />
        </Field>

        <Field label={`Inbound ${mbpsIn} Mbps`}>
          <input
            type="range"
            min={0}
            max={1000}
            value={mbpsIn}
            onChange={(e) => setMbpsIn(Number(e.target.value))}
            className="w-full"
          />
        </Field>
        <Field label={`Outbound ${mbpsOut} Mbps`}>
          <input
            type="range"
            min={0}
            max={1000}
            value={mbpsOut}
            onChange={(e) => setMbpsOut(Number(e.target.value))}
            className="w-full"
          />
        </Field>

        <Toggle checked={hasProgress} onChange={setHasProgress} label="progress available" />
        <Toggle checked={staleRun} onChange={setStaleRun} label="progress from a stale run" />
        <Toggle checked={forceFail} onChange={setForceFail} label="force visualization failure" />
      </section>

      <div className="w-full">
        <LiveVisualizationBoundary resetKey={runId} failed={forceFail}>
          <Suspense fallback={<VisualizationPending />}>
            <LiveTestDashboard presentation={presentation} />
          </Suspense>
        </LiveVisualizationBoundary>
      </div>

      <section className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Accessible summary
        </h2>
        <p className="text-sm text-gray-700 dark:text-gray-200">{describePresentation(presentation)}</p>
      </section>

      <section className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Presentation snapshot
        </h2>
        <pre className="overflow-x-auto text-[11px] leading-relaxed text-gray-600 dark:text-gray-300">
          {JSON.stringify(presentation, null, 2)}
        </pre>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function PlaceSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
    >
      {Object.keys(PLACES).map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
