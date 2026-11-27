import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type VideoFrameSource } from './pose-trace/video-frames';
import { encodeVideoToBlob } from './VideoConverterPage.encoding';

const putImageData = vi.fn<(frame: ImageData) => void>();
const stopTrack = vi.fn<() => void>();
const requestFrame = vi.fn<() => void>();
const renderedPixels: number[] = [];
let stoppedRecorders = 0;

class Recorder extends EventTarget {
  public state: RecordingState = 'inactive';
  public start() {
    this.state = 'recording';
  }
  public stop() {
    this.state = 'inactive';
    stoppedRecorders += 1;
    this.dispatchEvent(
      Object.assign(new Event('dataavailable'), {
        data: new Blob(['encoded']),
      }),
    );
    this.dispatchEvent(new Event('stop'));
  }
}

function source(): VideoFrameSource {
  return {
    key: 'top_camera',
    label: 'Top Camera',
    path: '/video',
    width: 1,
    height: 1,
    channels: 1,
    frameCount: 3,
    readFrame: vi.fn<VideoFrameSource['readFrame']>(
      async (index) => new Uint8Array([index + 10]),
    ),
  };
}

beforeEach(() => {
  stoppedRecorders = 0;
  renderedPixels.length = 0;
  putImageData.mockImplementation((frame) => {
    renderedPixels.push(frame.data[0]);
  });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    putImageData,
  } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: () => ({
      getVideoTracks: () => [{ requestFrame }],
      getTracks: () => [{ stop: stopTrack }],
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream');
});

describe('encodeVideoToBlob', () => {
  it('reads and encodes every frame in order through the streaming source', async () => {
    const video = source();
    const controller = new AbortController();
    const blob = await encodeVideoToBlob(
      video,
      'video/webm',
      1000,
      controller.signal,
    );
    expect(blob.size).toBeGreaterThan(0);
    expect(
      vi.mocked(video.readFrame).mock.calls.map(([index]) => index),
    ).toEqual([0, 1, 2]);
    expect(renderedPixels).toEqual([10, 11, 12]);
    expect(requestFrame).toHaveBeenCalledTimes(3);
    expect(stoppedRecorders).toBe(1);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('stops the recorder and tracks if a batch read fails', async () => {
    const video = source();
    vi.mocked(video.readFrame).mockImplementation(async (index) => {
      if (index > 0) {
        throw new Error('read failed');
      }
      return new Uint8Array([1]);
    });
    await expect(
      encodeVideoToBlob(
        video,
        'video/webm',
        1000,
        new AbortController().signal,
      ),
    ).rejects.toThrow('read failed');
    expect(stoppedRecorders).toBe(1);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('stops reading when the selection is cancelled', async () => {
    const video = source();
    const controller = new AbortController();
    vi.mocked(video.readFrame).mockImplementation(async (index) => {
      if (index > 0) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      return new Uint8Array([1]);
    });
    await expect(
      encodeVideoToBlob(video, 'video/webm', 1000, controller.signal),
    ).rejects.toThrow(/abort/iu);
    expect(video.readFrame).toHaveBeenCalledTimes(2);
    expect(stoppedRecorders).toBe(1);
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
