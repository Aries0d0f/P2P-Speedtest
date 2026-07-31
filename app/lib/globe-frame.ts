/** Builds the immutable frame handed to the globe scene. Every animated value
 * comes from the presentation selector; nothing is read back out of the scene. */

import { layoutForWidth } from "~/components/speedtest/three/globe-scene";
import type { GlobeFrame } from "~/model/globe.model";
import type { LiveTestPresentation, TransferToken } from "~/model/presentation.model";

/** Used before the stylesheet resolves and in non-browser tests. The live
 * values come from `app.css`, which is the single definition. */
export const FALLBACK_COLORS: Record<TransferToken, number> = {
  "--transfer-receive": 0x22d3ee,
  "--transfer-send": 0xa78bfa,
  "--transfer-duplex": 0x34d399,
  "--transfer-idle": 0x64748b,
};

const PEER_MARKER_COLOR = 0xf8fafc;

export function parseCssColor(value: string): number | null {
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
export function readToken(element: Element | null, token: TransferToken): number {
  if (!element || typeof getComputedStyle !== "function") return FALLBACK_COLORS[token];
  const value = getComputedStyle(element).getPropertyValue(token);
  return parseCssColor(value) ?? FALLBACK_COLORS[token];
}

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
