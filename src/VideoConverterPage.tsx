import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { FiDownload } from 'react-icons/fi';
import { createSearchParams, Link, useSearchParams } from 'react-router-dom';

import { formatUnknownError } from './error-utils';
import {
  listDemoVideos,
  loadDemoVideoFrames,
  openPoseTraceSource,
} from './pose-trace/hdf5';
import {
  type DemoVideoInfo,
  type DemoVideoKey,
  type PoseTraceSource,
} from './pose-trace/types';
import {
  createVideoFrameSource,
  type VideoFrameSource,
} from './pose-trace/video-frames';
import { type H5File, useStore } from './stores';
import { resolveFileUrl } from './utils';
import { VideoConverterEmptyState } from './VideoConverterEmptyState';
import { encodeVideoToBlob } from './VideoConverterPage.encoding';
import styles from './VideoConverterPage.module.css';
import {
  buildDownloadFilename,
  createFrameRenderer,
  formatDemoOption,
  getPlaybackTiming,
  getSupportedMimeType,
  getVideoFrameRate,
} from './VideoConverterPage.utils';

interface ResolvedFileState {
  file: H5File | null;
  loading: boolean;
  error: string | null;
}

interface SourceState {
  source: PoseTraceSource | null;
  loading: boolean;
  error: string | null;
}

interface CachedDownload {
  selectionKey: string;
  url: string;
}

function noop(): void {
  return undefined;
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

function useResolvedFile(fileUrl: string | null): ResolvedFileState {
  const opened = useStore((state) => state.opened);
  const openFiles = useStore((state) => state.openFiles);

  const [state, setState] = useState<ResolvedFileState>({
    file: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!fileUrl) {
      setState({ file: null, loading: false, error: null });
      return undefined;
    }

    const openedFile = opened.find((file) => file.url === fileUrl);
    if (openedFile) {
      setState({ file: openedFile, loading: false, error: null });
      return undefined;
    }

    let cancelled = false;
    const resolvedFileUrl = fileUrl;
    setState({ file: null, loading: true, error: null });

    async function resolveFile() {
      try {
        const resolvedFile = await resolveFileUrl(resolvedFileUrl);
        if (cancelled) {
          return;
        }

        if (!resolvedFile) {
          setState({
            file: null,
            loading: false,
            error:
              'This file cannot be reopened automatically. Open it again from the home page.',
          });
          return;
        }

        openFiles([resolvedFile]);
        setState({ file: resolvedFile, loading: false, error: null });
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setState({
          file: null,
          loading: false,
          error: formatUnknownError(error),
        });
      }
    }

    void resolveFile();

    return () => {
      cancelled = true;
    };
  }, [fileUrl, openFiles, opened]);

  return state;
}

function usePoseTraceSource(file: H5File | null): SourceState {
  const [state, setState] = useState<SourceState>({
    source: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let cleanup = noop;

    if (!file) {
      setState({ source: null, loading: false, error: null });
      return () => {
        cleanup();
      };
    }

    const resolvedFile = file;
    setState({ source: null, loading: true, error: null });

    async function openSource() {
      try {
        const source = await openPoseTraceSource(resolvedFile);
        if (cancelled) {
          source.cleanup();
          return;
        }

        ({ cleanup } = source);
        setState({ source, loading: false, error: null });
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setState({
          source: null,
          loading: false,
          error: formatUnknownError(error),
        });
      }
    }

    void openSource();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [file]);

  return state;
}

function VideoConverterPage() {
  const [searchParams] = useSearchParams();
  const fileUrl = searchParams.get('url');
  const opened = useStore((state) => state.opened);

  const {
    file,
    loading: fileLoading,
    error: fileError,
  } = useResolvedFile(fileUrl);
  const {
    source,
    loading: sourceLoading,
    error: sourceError,
  } = usePoseTraceSource(file);

  const [selectedDemo, setSelectedDemo] = useState<string | null>(null);
  const [videoOptions, setVideoOptions] = useState<DemoVideoInfo[]>([]);
  const [videoOptionsLoading, setVideoOptionsLoading] = useState(false);
  const [videoOptionsError, setVideoOptionsError] = useState<string | null>(
    null,
  );
  const [selectedVideoKey, setSelectedVideoKey] = useState<DemoVideoKey | null>(
    null,
  );
  const [videoData, setVideoData] = useState<VideoFrameSource | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const saveAbortRef = useRef<AbortController | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cachedDownloadRef = useRef<CachedDownload | null>(null);
  const supportedMimeType = useMemo(() => getSupportedMimeType(), []);

  const demos = useMemo(() => source?.demos ?? [], [source]);

  useEffect(() => {
    if (demos.length === 0) {
      setSelectedDemo(null);
      return;
    }

    setSelectedDemo((current) =>
      current && demos.some((demo) => demo.name === current)
        ? current
        : demos[0].name,
    );
  }, [demos]);

  useEffect(() => {
    if (!source || !selectedDemo) {
      setVideoOptions([]);
      setSelectedVideoKey(null);
      setVideoData(null);
      setVideoError(null);
      setVideoOptionsLoading(false);
      setVideoOptionsError(null);
      return undefined;
    }

    let cancelled = false;
    setVideoOptions([]);
    setSelectedVideoKey(null);
    setVideoData(null);
    setVideoError(null);
    setVideoOptionsLoading(true);
    setVideoOptionsError(null);

    const resolvedSource = source;
    const resolvedDemo = selectedDemo;

    async function loadVideos() {
      try {
        const nextVideos = await listDemoVideos(resolvedSource, resolvedDemo);
        if (cancelled) {
          return;
        }

        setVideoOptions(nextVideos);
        setSelectedVideoKey((current) => {
          if (current && nextVideos.some((video) => video.key === current)) {
            return current;
          }
          // Prefer a third-person/overview camera when available, otherwise the first one.
          const preferred = nextVideos.find((video) =>
            /(?:^|_)(?:external|front|overview|scene|third_person|top)(?:_|$)/iu.test(
              video.key,
            ),
          );
          return preferred ? preferred.key : (nextVideos.at(0)?.key ?? null);
        });
        setVideoOptionsLoading(false);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setVideoOptions([]);
        setSelectedVideoKey(null);
        setVideoOptionsLoading(false);
        setVideoOptionsError(formatUnknownError(error));
      }
    }

    void loadVideos();

    return () => {
      cancelled = true;
    };
  }, [selectedDemo, source]);

  useEffect(() => {
    const videoInfo = videoOptions.find(
      (video) => video.key === selectedVideoKey,
    );
    if (!source || !selectedDemo || !selectedVideoKey || !videoInfo) {
      setVideoData(null);
      setVideoLoading(false);
      setVideoError(null);
      return undefined;
    }

    const controller = new AbortController();
    setVideoData(null);
    setVideoLoading(true);
    setVideoError(null);
    setSaveError(null);

    const resolvedSource = source;
    const resolvedDemo = selectedDemo;
    const resolvedVideoKey = selectedVideoKey;
    const resolvedVideoInfo = videoInfo;

    async function loadVideo() {
      try {
        const nextVideo = createVideoFrameSource(
          resolvedVideoInfo,
          async (start, count) => {
            const batch = await loadDemoVideoFrames(
              resolvedSource,
              resolvedDemo,
              resolvedVideoKey,
              start,
              count,
            );
            return batch.frames;
          },
        );
        await nextVideo.readFrame(0, controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        setVideoData(nextVideo);
        setVideoLoading(false);
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          return;
        }

        setVideoData(null);
        setVideoLoading(false);
        setVideoError(formatUnknownError(error));
      }
    }

    void loadVideo();

    return () => {
      controller.abort();
    };
  }, [selectedDemo, selectedVideoKey, source, videoOptions]);

  const selectedVideoInfo = useMemo(
    () => videoOptions.find((video) => video.key === selectedVideoKey) ?? null,
    [selectedVideoKey, videoOptions],
  );

  const playbackFps = getVideoFrameRate(
    videoData?.fps ?? selectedVideoInfo?.fps,
  );

  // The schema discovers cameras dynamically, so we don't enforce a specific set.

  const selectionText = useMemo(() => {
    if (!selectedDemo) {
      return null;
    }

    const demo = demos.find((entry) => entry.name === selectedDemo);
    return {
      demo: selectedDemo,
      samples: demo?.num_samples ?? 'n/a',
      source: demo?.source_episode_index ?? 'n/a',
      success: demo && demo.success !== null ? Number(demo.success) : 'n/a',
    };
  }, [demos, selectedDemo]);

  const selectionKey = `${file?.url ?? fileUrl ?? 'file'}:${selectedDemo ?? 'demo'}:${selectedVideoKey ?? 'video'}`;
  const currentFrameLabel = videoData ? currentFrameIndex + 1 : 0;
  const currentTimeSeconds = videoData ? currentFrameIndex / playbackFps : 0;
  const totalTimeSeconds = videoData ? videoData.frameCount / playbackFps : 0;

  useEffect(() => {
    if (
      !cachedDownloadRef.current ||
      cachedDownloadRef.current.selectionKey === selectionKey
    ) {
      return;
    }

    URL.revokeObjectURL(cachedDownloadRef.current.url);
    cachedDownloadRef.current = null;
  }, [selectionKey]);

  useEffect(
    () => () => {
      if (cachedDownloadRef.current) {
        URL.revokeObjectURL(cachedDownloadRef.current.url);
        cachedDownloadRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    setCurrentFrameIndex(0);
    setIsPlaying(Boolean(videoData && videoData.frameCount > 1));
  }, [videoData]);

  useEffect(
    () => () => {
      saveAbortRef.current?.abort();
    },
    [videoData],
  );

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !videoData || isSaving) {
      return undefined;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    canvas.width = videoData.width;
    canvas.height = videoData.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      return undefined;
    }
    const renderFrame = createFrameRenderer(
      context,
      videoData.width,
      videoData.height,
      videoData.channels,
    );
    const video = videoData;
    async function drawFrame() {
      try {
        const index = Math.min(currentFrameIndex, video.frameCount - 1);
        const readStartedAt = performance.now();
        const frame = await video.readFrame(index, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        renderFrame(frame, 0);
        if (isPlaying && !isSaving && video.frameCount > 1) {
          const timing = getPlaybackTiming(
            playbackFps,
            performance.now() - readStartedAt,
          );
          timer = globalThis.setTimeout(() => {
            setCurrentFrameIndex(
              (current) =>
                (current + timing.framesToAdvance) % video.frameCount,
            );
          }, timing.delayMs);
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setVideoError(formatUnknownError(error));
          setIsPlaying(false);
        }
      }
    }
    void drawFrame();
    return () => {
      controller.abort();
      globalThis.clearTimeout(timer);
    };
  }, [currentFrameIndex, isPlaying, isSaving, playbackFps, videoData]);

  async function handleSaveVideo() {
    if (!videoData || !selectedDemo || !source) {
      return;
    }

    if (!supportedMimeType) {
      setSaveError('This browser cannot save the preview as a WebM video.');
      return;
    }

    setSaveError(null);

    const filename = buildDownloadFilename(
      source.datasetName,
      selectedDemo,
      videoData.key,
    );
    if (cachedDownloadRef.current?.selectionKey === selectionKey) {
      triggerDownload(cachedDownloadRef.current.url, filename);
      return;
    }

    setIsSaving(true);
    setIsPlaying(false);
    const controller = new AbortController();
    saveAbortRef.current = controller;
    try {
      const blob = await encodeVideoToBlob(
        videoData,
        supportedMimeType,
        playbackFps,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);

      if (cachedDownloadRef.current) {
        URL.revokeObjectURL(cachedDownloadRef.current.url);
      }

      cachedDownloadRef.current = {
        selectionKey,
        url,
      };
      triggerDownload(url, filename);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setSaveError(formatUnknownError(error));
      }
    } finally {
      saveAbortRef.current = null;
      setIsSaving(false);
    }
  }

  function renderPreviewContent() {
    if (
      videoOptions.length === 0 &&
      !videoOptionsLoading &&
      !videoOptionsError
    ) {
      return (
        <p className={styles.infoText}>
          No supported video datasets were found. Expected one or more (T, H, W,
          C) datasets under `obs/cameras/` or directly under `obs/`.
        </p>
      );
    }

    if (videoLoading) {
      return <p className={styles.infoText}>Loading video frames…</p>;
    }

    if (videoError) {
      return <p className={styles.errorText}>{videoError}</p>;
    }

    if (!videoData) {
      return <p className={styles.infoText}>Select a video to preview it.</p>;
    }

    return (
      <div className={styles.previewSurface}>
        <div className={styles.previewViewport}>
          <canvas
            ref={previewCanvasRef}
            className={styles.previewCanvas}
            aria-label="Video frame preview"
          />
        </div>
        <div className={styles.playerControls}>
          <div className={styles.sliderBlock}>
            <input
              className={styles.timelineSlider}
              type="range"
              aria-label="Video timeline"
              min={0}
              max={Math.max(videoData.frameCount - 1, 0)}
              step={1}
              value={currentFrameIndex}
              onChange={(event) => {
                setCurrentFrameIndex(Number(event.target.value));
              }}
              disabled={isSaving || videoData.frameCount <= 1}
            />
            <div className={styles.sliderMeta}>
              <span>
                Frame {currentFrameLabel}/{videoData.frameCount}
              </span>
              <span>
                {currentTimeSeconds.toFixed(2)}s / {totalTimeSeconds.toFixed(2)}
                s
              </span>
            </div>
          </div>
          <button
            type="button"
            className={styles.playBtn}
            onClick={() => {
              setIsPlaying((current) => !current);
            }}
            disabled={isSaving || videoData.frameCount <= 1}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
        </div>
      </div>
    );
  }

  function renderInitialEmptyState() {
    if (fileUrl || file || fileLoading) {
      return null;
    }

    return <VideoConverterEmptyState openedFileCount={opened.length} />;
  }

  function renderNoSourceState() {
    if (
      source ||
      fileLoading ||
      sourceLoading ||
      fileError ||
      sourceError ||
      !fileUrl
    ) {
      return null;
    }

    return (
      <section className={styles.messageCard}>
        <p>
          Select an opened file from the sidebar to inspect demo videos, or go
          back to the viewer.
        </p>
        <div className={styles.emptyActions}>
          <Link
            className={styles.openBtn}
            to={`/video-converter?${createSearchParams({ url: fileUrl }).toString()}`}
          >
            Retry
          </Link>
          <Link className={styles.openBtn} to="/">
            Open HDF5
          </Link>
        </div>
      </section>
    );
  }

  function renderErrorMessage(error: string | null) {
    if (!error) {
      return null;
    }

    return (
      <section className={styles.messageCard}>
        <p className={styles.errorText}>{error}</p>
      </section>
    );
  }

  function renderPage() {
    return (
      <div className={styles.root}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Analysis</p>
            <h1 className={styles.title}>Video Converter</h1>
            <p className={styles.subtitle}>
              Preview RGB demo videos stored in the current HDF5 file and save
              them to disk only when needed.
            </p>
          </div>
        </header>

        {renderInitialEmptyState()}

        {renderErrorMessage(fileError)}

        {(fileLoading || sourceLoading) && (
          <section className={styles.messageCard}>
            <p>Loading video-converter data…</p>
          </section>
        )}

        {renderErrorMessage(sourceError)}

        {source && (
          <>
            <section className={styles.controlsCard}>
              <div className={styles.controlGrid}>
                <div className={styles.field}>
                  <label
                    className={styles.fieldLabel}
                    htmlFor="video-demo-select"
                  >
                    Demo
                  </label>
                  <select
                    id="video-demo-select"
                    className={styles.select}
                    value={selectedDemo ?? ''}
                    onChange={(event) => {
                      const nextDemo = event.target.value;
                      startTransition(() => {
                        setSelectedDemo(nextDemo);
                      });
                    }}
                    disabled={demos.length === 0}
                  >
                    {demos.length === 0 && (
                      <option value="">No demos available</option>
                    )}
                    {demos.map((demo) => (
                      <option key={demo.name} value={demo.name}>
                        {formatDemoOption(demo)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.field}>
                  <label
                    className={styles.fieldLabel}
                    htmlFor="video-stream-select"
                  >
                    Video
                  </label>
                  <select
                    id="video-stream-select"
                    className={styles.select}
                    value={selectedVideoKey ?? ''}
                    onChange={(event) => {
                      const nextVideo = event.target.value;
                      startTransition(() => {
                        setSelectedVideoKey(nextVideo || null);
                      });
                    }}
                    disabled={videoOptionsLoading || videoOptions.length === 0}
                  >
                    {videoOptions.length === 0 && (
                      <option value="">
                        {videoOptionsLoading
                          ? 'Loading videos…'
                          : 'No supported videos found'}
                      </option>
                    )}
                    {videoOptions.map((video) => (
                      <option key={video.key} value={video.key}>
                        {video.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={styles.statusRow}>
                <div className={styles.statusItem} aria-label="Demo count">
                  <span className={styles.statusKey}>Demos:</span>{' '}
                  {demos.length}
                </div>
                {selectionText && (
                  <>
                    <div className={styles.statusItem}>
                      <span className={styles.statusKey}>Selected:</span>{' '}
                      {selectionText.demo}
                    </div>
                    <div className={styles.statusItem}>
                      <span className={styles.statusKey}>Samples:</span>{' '}
                      {selectionText.samples}
                    </div>
                    <div className={styles.statusItem}>
                      <span className={styles.statusKey}>Source:</span>{' '}
                      {selectionText.source}
                    </div>
                    <div className={styles.statusItem}>
                      <span className={styles.statusKey}>Success:</span>{' '}
                      {selectionText.success}
                    </div>
                  </>
                )}
                {selectedVideoInfo && (
                  <>
                    <div className={styles.statusItem}>
                      <span className={styles.statusKey}>Frames:</span>{' '}
                      {selectedVideoInfo.frameCount}
                    </div>
                    <div className={styles.statusItem}>
                      <span className={styles.statusKey}>Resolution:</span>{' '}
                      {selectedVideoInfo.width}×{selectedVideoInfo.height}
                    </div>
                  </>
                )}
              </div>
            </section>

            {videoOptionsError && (
              <section className={styles.messageCard}>
                <p className={styles.errorText}>{videoOptionsError}</p>
              </section>
            )}

            <section className={styles.previewCard}>
              <div className={styles.previewHeader}>
                <div>
                  <h2 className={styles.previewTitle}>
                    {selectedVideoInfo
                      ? `${selectedVideoInfo.label} Preview`
                      : 'Video Preview'}
                  </h2>
                  <p className={styles.previewMeta}>
                    {selectedVideoInfo
                      ? `${selectedVideoInfo.path} · ${playbackFps} FPS preview`
                      : 'Choose a demo video to preview it.'}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={() => {
                    void handleSaveVideo();
                  }}
                  disabled={!videoData || isSaving || !supportedMimeType}
                >
                  <FiDownload aria-hidden />
                  <span>{isSaving ? 'Saving…' : 'Save Video'}</span>
                </button>
              </div>

              {!supportedMimeType && (
                <p className={styles.hintText}>
                  Saving is unavailable in this browser because WebM recording
                  is not supported.
                </p>
              )}

              {saveError && <p className={styles.errorText}>{saveError}</p>}

              {renderPreviewContent()}
            </section>
          </>
        )}

        {renderNoSourceState()}
      </div>
    );
  }

  return renderPage();
}

export default VideoConverterPage;
