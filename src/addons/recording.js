import downloadBlob from '../scaffolding/download';

// Ordered from best to worst. Browsers only support a subset of these.
const PREFERRED_MIME_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm'
];

const getSupportedMimeType = () => {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return '';
};

const getFileExtension = (mimeType) => {
  if (!mimeType) {
    return 'webm';
  }
  const subtype = mimeType.split(';')[0].split('/')[1];
  return subtype || 'webm';
};

const getRecordingFilename = (mimeType) => {
  const title = (document.title || 'recording').replace(/[\\/:*?"<>|]/g, '-').trim();
  return `${title || 'recording'}.${getFileExtension(mimeType)}`;
};

// Selectable output heights. `source` keeps whatever the stage currently renders at.
const RESOLUTION_HEIGHTS = {
  source: null,
  '720': 720,
  '1080': 1080,
  '1440': 1440,
  '2160': 2160
};

const DEFAULT_ASPECT_RATIO = 480 / 360;

// Roughly 0.2 bits per pixel per frame: comfortably above the default bitrate
// (which causes visible banding) without producing absurdly large files.
const BITS_PER_PIXEL_PER_SECOND = 0.2;
const MIN_VIDEO_BITRATE = 8_000_000;
const MAX_VIDEO_BITRATE = 120_000_000;

const getResolutionSize = (resolution, displayWidth, displayHeight) => {
  const targetHeight = RESOLUTION_HEIGHTS[resolution];
  if (!targetHeight) {
    // Unknown or "source": leave the stage rendering at whatever it already is.
    return {width: displayWidth, height: displayHeight};
  }
  const aspectRatio = displayHeight ? displayWidth / displayHeight : DEFAULT_ASPECT_RATIO;
  const targetWidth = Math.round(targetHeight * aspectRatio);
  return {
    // Encoders reject odd dimensions for some codecs.
    width: targetWidth % 2 === 0 ? targetWidth : targetWidth + 1,
    height: targetHeight
  };
};

const getVideoBitrate = (width, height, frameRate) => {
  const bitrate = Math.round(width * height * frameRate * BITS_PER_PIXEL_PER_SECOND);
  return Math.max(MIN_VIDEO_BITRATE, Math.min(MAX_VIDEO_BITRATE, bitrate));
};

const FRAME_RATE = 30;

const run = ({ scaffolding, options = {} }) => {
  const vm = scaffolding.vm;

  const mimeType = getSupportedMimeType();
  if (mimeType === null) {
    console.warn('Recording addon: MediaRecorder is not supported in this browser');
    return;
  }

  const renderer = vm.runtime.renderer;
  if (!renderer || !renderer.canvas || typeof renderer.canvas.captureStream !== 'function') {
    console.warn('Recording addon: canvas captureStream is not supported in this browser');
    return;
  }

  let recorder = null;
  let stream = null;
  let chunks = [];
  // Kept so it can be disconnected when recording ends instead of permanently
  // rerouting the project's audio into a recording destination.
  let audioDestination = null;
  // Set while the renderer's canvas is oversized for a high resolution recording.
  let restoreCanvasSize = null;

  // captureStream() captures the canvas *backing store*, not its on-screen size,
  // so going fullscreen alone never improves the recording. Rendering the stage
  // at a larger backing store is the only way to get a genuinely sharper video.
  const applyHighResolution = () => {
    const canvas = renderer.canvas;
    const devicePixelRatio = window.devicePixelRatio || 1;
    // The canvas fills its container (width/height: 100%), so its CSS pixel size
    // is the stage's on-screen size. Fall back to the backing store if unlaid out.
    const displayWidth = canvas.clientWidth || Math.round(canvas.width / devicePixelRatio);
    const displayHeight = canvas.clientHeight || Math.round(canvas.height / devicePixelRatio);
    const target = getResolutionSize(options.recordingResolution, displayWidth, displayHeight);
    if (target.width === displayWidth && target.height === displayHeight) {
      return target;
    }

    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    // Only the number of rendered pixels changes; the CSS sizing is untouched, so
    // the project looks exactly the same on screen while it records.
    restoreCanvasSize = () => {
      if (typeof renderer.resize === 'function') {
        // Go through `resize` again so overlays and render quality follow the
        // canvas back down; then re-assert the exact previous backing store.
        renderer.resize(previousWidth / devicePixelRatio, previousHeight / devicePixelRatio);
      }
      canvas.width = previousWidth;
      canvas.height = previousHeight;
      if (renderer.dirty !== undefined) {
        renderer.dirty = true;
        renderer.draw();
      }
    };

    if (typeof renderer.resize === 'function') {
      // `resize` also refreshes render quality and overlays, which a raw
      // canvas.width assignment would skip.
      renderer.resize(target.width, target.height);
      // `resize` multiplies by devicePixelRatio; re-assert the requested size so
      // the encoded resolution is exactly what was asked for on high-DPI screens.
      if (devicePixelRatio !== 1) {
        canvas.width = target.width;
        canvas.height = target.height;
      }
    } else {
      canvas.width = target.width;
      canvas.height = target.height;
    }

    if (renderer.dirty !== undefined) {
      renderer.dirty = true;
      renderer.draw();
    }

    return target;
  };

  const buildStream = () => {
    const result = new MediaStream();

    const canvasStream = renderer.canvas.captureStream(FRAME_RATE);
    for (const track of canvasStream.getVideoTracks()) {
      result.addTrack(track);
    }

    const audioEngine = vm.runtime.audioEngine;
    if (audioEngine && audioEngine.audioContext && audioEngine.inputNode) {
      audioDestination = audioEngine.audioContext.createMediaStreamDestination();
      audioEngine.inputNode.connect(audioDestination);
      for (const track of audioDestination.stream.getAudioTracks()) {
        result.addTrack(track);
      }
    }

    return result;
  };

  const dispose = () => {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    recorder = null;
    chunks = [];
    if (audioDestination) {
      audioDestination.disconnect();
      audioDestination = null;
    }
    if (restoreCanvasSize) {
      restoreCanvasSize();
      restoreCanvasSize = null;
    }
  };

  const start = () => {
    // A new green flag must not interrupt an already running recording.
    if (recorder) {
      return;
    }

    let size;
    try {
      size = applyHighResolution();
      stream = buildStream();
    } catch (error) {
      console.error('Recording addon: failed to start recording', error);
      dispose();
      return;
    }

    const recorderOptions = {};
    if (mimeType) {
      recorderOptions.mimeType = mimeType;
    }
    recorderOptions.videoBitsPerSecond = getVideoBitrate(size.width, size.height, FRAME_RATE);

    recorder = new MediaRecorder(stream, recorderOptions);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, {type: mimeType || 'video/webm'});
      downloadBlob(getRecordingFilename(mimeType), blob);
      dispose();
    };
    recorder.onerror = (event) => {
      console.error('Recording addon: recorder error', event.error);
      dispose();
    };
    recorder.start();
  };

  const stop = () => {
    if (!recorder || recorder.state === 'inactive') {
      return;
    }
    recorder.stop();
  };

  vm.runtime.on('PROJECT_START', start);

  document.addEventListener('keydown', (e) => {
    // Don't hijack the 1 key while the user is typing into the ask prompt or
    // an editable list monitor.
    if (e.target !== document && e.target !== document.body) {
      return;
    }
    if (e.key === '1' || e.keyCode === 49) {
      stop();
    }
  });
};

export {
  getSupportedMimeType,
  getFileExtension,
  getRecordingFilename,
  getResolutionSize,
  getVideoBitrate,
  RESOLUTION_HEIGHTS
};

export default run;
