import { describe, expect, it, vi } from 'vitest';

import { type DemoVideoInfo } from './types';
import {
  createVideoFrameSource,
  MAX_VIDEO_BATCH_BYTES,
  readVideoFrameBatch,
} from './video-frames';

type BatchReader = Parameters<typeof createVideoFrameSource>[1];
type DatasetSlice = Parameters<typeof readVideoFrameBatch>[0]['slice'];

const info: DemoVideoInfo = {
  key: 'top_camera',
  label: 'Top Camera',
  path: '/data/demo_0/obs/cameras/top_camera',
  frameCount: 3679,
  height: 480,
  width: 640,
  channels: 3,
  chunkFrameCount: 230,
};

describe('readVideoFrameBatch', () => {
  it('reads a hyperslab of a multi-GB video without reading dataset.value', () => {
    const frames = new Uint8Array(480 * 640 * 3);
    const slice = vi.fn<DatasetSlice>().mockReturnValue(frames);
    const dataset = {
      path: info.path,
      shape: [3679, 480, 640, 3],
      slice,
      get value(): never {
        throw new Error('Full video must not be loaded');
      },
    };
    expect(readVideoFrameBatch(dataset, 3678, 1)).toBe(frames);
    expect(slice).toHaveBeenCalledExactlyOnceWith([[3678, 3679]]);
    expect(() => readVideoFrameBatch(dataset, 0, 3679)).toThrow('256 MiB');
  });

  it.each([
    [-1, 1],
    [0, 0],
    [3679, 1],
    [1.5, 1],
    [0, Number.NaN],
  ])('rejects invalid range %s/%s before reading', (start, count) => {
    const slice = vi.fn<DatasetSlice>();
    expect(() =>
      readVideoFrameBatch(
        { path: info.path, shape: [3679, 480, 640, 3], slice },
        start,
        count,
      ),
    ).toThrow('Invalid');
    expect(slice).not.toHaveBeenCalled();
  });
});

describe('createVideoFrameSource', () => {
  it('requests a bounded chunk-aligned batch for the failing dataset', async () => {
    const readBatch = vi
      .fn<BatchReader>()
      .mockRejectedValue(new Error('stop before allocating'));
    const source = createVideoFrameSource(info, readBatch);
    await expect(source.readFrame(500)).rejects.toThrow(
      'stop before allocating',
    );
    expect(readBatch).toHaveBeenCalledWith(460, 230);
    expect(230 * 480 * 640 * 3).toBeLessThanOrEqual(MAX_VIDEO_BATCH_BYTES);
  });

  it('renders the last frame, seeks backwards, and reuses the current batch', async () => {
    // One grayscale frame occupies half the budget, so each batch holds two.
    // Fake byte lengths avoid allocating hundreds of MB in the unit test.
    const bytesPerFrame = MAX_VIDEO_BATCH_BYTES / 2;
    const subarray = vi
      .fn<Uint8Array['subarray']>()
      .mockReturnValue(new Uint8Array([42]));
    const readBatch = vi.fn<BatchReader>(
      async (_start: number, count: number) =>
        ({
          byteLength: count * bytesPerFrame,
          subarray,
        }) as unknown as Uint8Array,
    );
    const source = createVideoFrameSource(
      {
        ...info,
        frameCount: 5,
        width: bytesPerFrame,
        height: 1,
        channels: 1,
        chunkFrameCount: 1,
      },
      readBatch,
    );
    await source.readFrame(0);
    await source.readFrame(1);
    expect(readBatch).toHaveBeenCalledOnce();
    expect(subarray).toHaveBeenLastCalledWith(bytesPerFrame, 2 * bytesPerFrame);
    await source.readFrame(4);
    expect(readBatch).toHaveBeenLastCalledWith(4, 1);
    await source.readFrame(0);
    expect(readBatch).toHaveBeenLastCalledWith(0, 2);
    expect(readBatch).toHaveBeenCalledTimes(3);
  });

  it('serializes concurrent reads and skips cancelled seeks', async () => {
    const deferred = Promise.withResolvers<Uint8Array>();
    const readBatch = vi.fn<BatchReader>(async () => deferred.promise);
    const source = createVideoFrameSource(
      { ...info, frameCount: 3, width: 1, height: 1, channels: 1 },
      readBatch,
    );
    const first = source.readFrame(0);
    const controller = new AbortController();
    const cancelled = source.readFrame(2, controller.signal);
    const results = Promise.allSettled([first, cancelled]);
    controller.abort();
    await vi.waitFor(() => {
      expect(readBatch).toHaveBeenCalledOnce();
    });
    deferred.resolve(new Uint8Array([10, 20, 30]));
    const [firstResult, cancelledResult] = await results;
    expect(firstResult).toEqual({
      status: 'fulfilled',
      value: new Uint8Array([10]),
    });
    expect(cancelledResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ name: 'AbortError' }),
    });
    await expect(source.readFrame(1)).resolves.toEqual(new Uint8Array([20]));
    expect(readBatch).toHaveBeenCalledOnce();
  });
});
