import { type Dataset } from 'h5wasm';

import { type DemoVideoInfo } from './types';

export const MAX_VIDEO_BATCH_BYTES = 256 * 1024 * 1024;

/** Read a bounded hyperslab, avoiding dataset.value and its full-video buffer. */
export function readVideoFrameBatch(
  dataset: Pick<Dataset, 'shape' | 'path' | 'slice'>,
  startFrame: number,
  frameCount: number,
): Uint8Array {
  const { shape } = dataset;
  if (
    shape?.length !== 4 ||
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(frameCount) ||
    startFrame < 0 ||
    frameCount <= 0 ||
    startFrame + frameCount > shape[0]
  ) {
    throw new Error('Invalid video frame range.');
  }

  const byteCount = frameCount * shape[1] * shape[2] * shape[3];
  if (byteCount > MAX_VIDEO_BATCH_BYTES) {
    throw new Error('Video frame batch exceeds the 256 MiB limit.');
  }

  const frames = dataset.slice([[startFrame, startFrame + frameCount]]);
  if (!(frames instanceof Uint8Array) || frames.byteLength !== byteCount) {
    throw new Error(
      `Dataset '${dataset.path}' must contain uint8 video frames.`,
    );
  }
  return frames;
}

export interface VideoFrameSource extends DemoVideoInfo {
  readFrame: (index: number, signal?: AbortSignal) => Promise<Uint8Array>;
}

/** Retain one batch and serialize reads so scrubbing cannot accumulate buffers. */
export function createVideoFrameSource(
  info: DemoVideoInfo,
  readBatch: (startFrame: number, frameCount: number) => Promise<Uint8Array>,
): VideoFrameSource {
  const bytesPerFrame = info.width * info.height * info.channels;
  if (
    !Number.isSafeInteger(bytesPerFrame) ||
    bytesPerFrame <= 0 ||
    bytesPerFrame > MAX_VIDEO_BATCH_BYTES ||
    !Number.isSafeInteger(info.frameCount) ||
    info.frameCount <= 0
  ) {
    throw new Error('Video has an unsupported frame size or frame count.');
  }

  const maxFrames = Math.floor(MAX_VIDEO_BATCH_BYTES / bytesPerFrame);
  const chunkFrames = info.chunkFrameCount ?? 1;
  // Align reads to HDF5 chunks to avoid repeatedly decompressing the same frames.
  const batchSize =
    Number.isSafeInteger(chunkFrames) &&
    chunkFrames > 0 &&
    chunkFrames <= maxFrames
      ? Math.floor(maxFrames / chunkFrames) * chunkFrames
      : maxFrames;
  let cached: { start: number; frames: Uint8Array } | null = null;
  let pending = Promise.resolve<undefined>(undefined);

  return {
    ...info,
    async readFrame(index, signal) {
      const previous = pending;
      const next = Promise.withResolvers<undefined>();
      pending = next.promise;
      try {
        await previous;
        signal?.throwIfAborted();
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= info.frameCount
        ) {
          throw new Error('Video frame index is out of range.');
        }
        const start = Math.floor(index / batchSize) * batchSize;
        if (cached?.start !== start) {
          cached = null;
          const count = Math.min(batchSize, info.frameCount - start);
          const frames = await readBatch(start, count);
          if (frames.byteLength !== count * bytesPerFrame) {
            throw new Error('Video frame batch is incomplete.');
          }
          // eslint-disable-next-line require-atomic-updates -- The pending queue serializes cache updates.
          cached = { start, frames };
        }
        signal?.throwIfAborted();
        const offset = (index - start) * bytesPerFrame;
        return cached.frames.subarray(offset, offset + bytesPerFrame);
      } finally {
        next.resolve(undefined);
      }
    },
  };
}
