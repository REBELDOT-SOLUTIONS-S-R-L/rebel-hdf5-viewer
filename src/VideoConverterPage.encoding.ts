import { type VideoFrameSource } from './pose-trace/video-frames';
import { createFrameRenderer } from './VideoConverterPage.utils';

export async function encodeVideoToBlob(
  video: VideoFrameSource,
  mimeType: string,
  fps: number,
  signal: AbortSignal,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = video.width;
  canvas.height = video.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Could not create a canvas context for video encoding.');
  }
  const renderFrame = createFrameRenderer(
    context,
    video.width,
    video.height,
    video.channels,
  );
  // Load the first batch before recording so disk reads cannot add a blank lead-in.
  signal.throwIfAborted();
  renderFrame(await video.readFrame(0, signal), 0);
  const stream = canvas.captureStream(fps);
  let recorder: MediaRecorder | null = null;
  try {
    signal.throwIfAborted();
    recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    const status: { error: Error | null } = { error: null };
    const stopped = new Promise<Blob>((resolve) => {
      recorder?.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });
      recorder?.addEventListener('error', () => {
        status.error = new Error('Video encoding failed.');
      });
      recorder?.addEventListener('stop', () => {
        resolve(new Blob(chunks, { type: mimeType }));
      });
    });

    recorder.start(1000);
    const [track] = stream.getVideoTracks();
    const canvasTrack = track as CanvasCaptureMediaStreamTrack;
    const frameDuration = 1000 / fps;
    for (let index = 0; index < video.frameCount; index += 1) {
      signal.throwIfAborted();
      if (status.error) {
        throw status.error;
      }
      if (index > 0) {
        // eslint-disable-next-line no-await-in-loop -- Read and release frames sequentially to bound memory.
        renderFrame(await video.readFrame(index, signal), 0);
      }
      if (typeof canvasTrack.requestFrame === 'function') {
        canvasTrack.requestFrame();
      }
      // eslint-disable-next-line no-await-in-loop -- MediaRecorder captures frames in real time.
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, frameDuration);
      });
    }
    signal.throwIfAborted();
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    const blob = await stopped;
    if (status.error) {
      throw status.error;
    }
    return blob;
  } finally {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}
