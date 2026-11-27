import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type listDemoVideos,
  type loadDemoVideoFrames,
  type openPoseTraceSource,
} from './pose-trace/hdf5';
import { FileService, type H5File, useStore } from './stores';
import VideoConverterPage from './VideoConverterPage';

const mocks = vi.hoisted(() => ({
  listDemoVideos: vi.fn<typeof listDemoVideos>(),
  loadDemoVideoFrames: vi.fn<typeof loadDemoVideoFrames>(),
  openPoseTraceSource: vi.fn<typeof openPoseTraceSource>(),
}));

vi.mock(import('./pose-trace/hdf5'), () => ({
  listDemoVideos: mocks.listDemoVideos,
  loadDemoVideoFrames: mocks.loadDemoVideoFrames,
  openPoseTraceSource: mocks.openPoseTraceSource,
}));

function localFile(name = 'clip.hdf5'): H5File {
  return {
    url: `u-${name}`,
    name,
    service: FileService.Local,
    resolvedUrl: `blob:${name}`,
    file: new File([new Uint8Array([1])], name),
  };
}

function renderPage(initialUrl = '/video-converter'): void {
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <VideoConverterPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStore.setState({ opened: [] }, false);
  mocks.openPoseTraceSource.mockResolvedValue({
    sourceId: 's1',
    datasetName: 'clip',
    demos: [
      {
        name: 'demo_0',
        episode_index: 0,
        num_samples: 5,
        success: true,
        source_episode_index: 0,
      },
    ],
    articulation: null,
    cleanup: vi.fn<() => void>(),
  });
  mocks.listDemoVideos.mockResolvedValue([]);
});

afterEach(() => {
  useStore.setState({ opened: [] }, false);
});

describe('VideoConverterPage', () => {
  it('previews and seeks using a bounded frame range while retaining the full timeline', async () => {
    const putImageData = vi.fn<(frame: ImageData) => void>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      putImageData,
    } as unknown as CanvasRenderingContext2D);
    const file = localFile();
    useStore.setState({ opened: [file] }, false);
    const video = {
      key: 'top_camera',
      label: 'Top Camera',
      path: '/video',
      frameCount: 5,
      width: 1,
      height: 1,
      channels: 1,
    };
    mocks.listDemoVideos.mockResolvedValue([video]);
    mocks.loadDemoVideoFrames.mockResolvedValue({
      ...video,
      frames: new Uint8Array([10, 20, 30, 40, 50]),
    });
    renderPage(`/video-converter?url=${encodeURIComponent(file.url)}`);
    await expect(
      screen.findByLabelText('Video frame preview'),
    ).resolves.toBeInTheDocument();
    // eslint-disable-next-line testing-library/prefer-user-event -- This project uses fireEvent without the user-event package.
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const timeline = screen.getByLabelText('Video timeline');
    expect(timeline).toHaveAttribute('max', '4');
    // eslint-disable-next-line testing-library/prefer-user-event -- Exercise the range input's change event directly.
    fireEvent.change(timeline, { target: { value: '4' } });
    await waitFor(() => {
      expect(putImageData.mock.calls.at(-1)?.[0].data[0]).toBe(50);
    });
    expect(mocks.loadDemoVideoFrames).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceId: 's1' }),
      'demo_0',
      'top_camera',
      0,
      5,
    );
  });

  it('uses recorded FPS for the preview duration', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      putImageData: vi.fn<(frame: ImageData) => void>(),
    } as unknown as CanvasRenderingContext2D);
    const file = localFile();
    useStore.setState({ opened: [file] }, false);
    const video = {
      key: 'top_camera',
      label: 'Top Camera',
      path: '/video',
      frameCount: 60,
      width: 1,
      height: 1,
      channels: 1,
      fps: 60,
    };
    mocks.listDemoVideos.mockResolvedValue([video]);
    mocks.loadDemoVideoFrames.mockResolvedValue({
      ...video,
      frames: new Uint8Array(60),
    });
    renderPage(`/video-converter?url=${encodeURIComponent(file.url)}`);
    await expect(
      screen.findByText('/video · 60 FPS preview'),
    ).resolves.toBeInTheDocument();
    await expect(screen.findByText(/s \/ 1\.00/u)).resolves.toBeInTheDocument();
  });

  it('shows the empty state when no file is open', () => {
    renderPage();
    expect(
      screen.getByText(/Open an HDF5 file in rebelHDF5/u),
    ).toBeInTheDocument();
  });

  it('opens the source and renders the demo selector for the resolved file', async () => {
    const file = localFile('clip.hdf5');
    useStore.setState({ opened: [file] }, false);
    renderPage(`/video-converter?url=${encodeURIComponent(file.url)}`);

    // The demo dropdown appears once the (mocked) source is opened.
    const demoSelect = await screen.findByLabelText('Demo');
    expect(mocks.openPoseTraceSource).toHaveBeenCalledWith(file);
    expect(
      within(demoSelect).getByRole('option', { name: /demo_0/u }),
    ).toBeInTheDocument();

    // Status row reflects the single demo.
    await waitFor(() => {
      expect(screen.getByLabelText('Demo count')).toHaveTextContent('1');
    });
    // With no videos, the video selector shows the empty message.
    await expect(
      screen.findByText('No supported videos found'),
    ).resolves.toBeInTheDocument();
  });
});
