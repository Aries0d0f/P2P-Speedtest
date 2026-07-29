import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNELS_PER_BULK_CONNECTION,
  WebrtcConnection,
} from "./webrtc";

class FakeDataChannel {
  readonly label: string;
  binaryType: BinaryType = "arraybuffer";
  readyState: RTCDataChannelState = "connecting";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(label: string) {
    this.label = label;
  }

  close(): void {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string): RTCDataChannel {
    return new FakeDataChannel(label) as unknown as RTCDataChannel;
  }

  emitRemoteDataChannel(label: string): void {
    const channel = new FakeDataChannel(label) as unknown as RTCDataChannel;
    this.ondatachannel?.({ channel } as RTCDataChannelEvent);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0" };
  }

  async setLocalDescription(): Promise<void> {}

  close(): void {
    this.connectionState = "closed";
  }
}

describe("WebrtcConnection bulk channel ownership", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands offerer and answerer bulk channels off synchronously at creation", () => {
    const offererChannels: Array<{ channel: RTCDataChannel; index: number }> = [];
    const offererOpen = vi.fn();
    new WebrtcConnection({
      slot: 0,
      runId: "11111111-2222-4333-8444-555555555555",
      connIndex: 1,
      role: "bulk",
      iceServers: [],
      send: () => {},
      callbacks: {
        onBulkChannelCreated: (channel, index) => {
          // No main-thread open handler may be installed first: ownership
          // has to leave this context in the creation task.
          expect(channel.onopen).toBeNull();
          offererChannels.push({ channel, index });
        },
        onChannelOpen: offererOpen,
      },
    });

    expect(offererChannels.map(({ index }) => index)).toEqual(
      Array.from({ length: CHANNELS_PER_BULK_CONNECTION }, (_, index) => index),
    );
    expect(offererOpen).not.toHaveBeenCalled();

    const answererChannels: Array<{ channel: RTCDataChannel; index: number }> = [];
    new WebrtcConnection({
      slot: 1,
      runId: "11111111-2222-4333-8444-555555555555",
      connIndex: 1,
      role: "bulk",
      iceServers: [],
      send: () => {},
      callbacks: {
        onBulkChannelCreated: (channel, index) =>
          answererChannels.push({ channel, index }),
      },
    });
    const answererPc = FakePeerConnection.instances[1];
    answererPc.emitRemoteDataChannel("bulk-0");
    answererPc.emitRemoteDataChannel("bulk-1");

    expect(answererChannels.map(({ index }) => index)).toEqual([0, 1]);
  });
});
