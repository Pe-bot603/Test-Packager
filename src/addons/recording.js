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
    return { width: displayWidth, height: displayHeight };
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
  // True from the internal stopAll() that greenFlag() runs until that flag's
  // PROJECT_START, so a flag press is not mistaken for the "stop all" block.
  let resettingForGreenFlag = false;

  // captureStream() captures the canvas *backing store*, not its on-screen size,
  // so going fullscreen alone never improves the recording. Rendering the stage
  // at a larger backing store is the only way to get a genuinely sharper video.
  const applyHighResolution = () => {
    const canvas = renderer.canvas;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const displayWidth = canvas.clientWidth || Math.round(canvas.width / devicePixelRatio);
    const displayHeight = canvas.clientHeight || Math.round(canvas.height / devicePixelRatio);
    const target = getResolutionSize(options.recordingResolution, displayWidth, displayHeight);

    // "source" means "whatever the stage already renders at", so there is no
    // fixed size to hold: the recording follows the on-screen size.
    if (!RESOLUTION_HEIGHTS[options.recordingResolution]) {
      return target;
    }

    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    // Any later relayout (the loading screen going away, fullscreen, a window
    // resize, the stage being resized by the project) calls renderer.resize with
    // the on-screen size, which would silently shrink the canvas back down and
    // throw away the chosen resolution halfway through the recording. Ignore
    // those for as long as the recording lasts: the recording size is fixed, and
    // the CSS size is what keeps the project looking right on screen.
    const originalResize = renderer.resize;
    const setBackingStore = () => {
      if (canvas.width === target.width && canvas.height === target.height) {
        return;
      }
      // `resize` multiplies by devicePixelRatio, so try it first for render
      // quality and overlays, then set the backing store directly. On high-DPI
      // screens that makes the encoded size exactly the requested one in pixels
      // rather than a multiple of it.
      if (typeof originalResize === 'function') {
        originalResize.call(renderer, target.width, target.height);
      }
      canvas.width = target.width;
      canvas.height = target.height;
      if (renderer.dirty !== undefined) {
        renderer.dirty = true;
        renderer.draw();
      }
    };
    if (typeof originalResize === 'function') {
      renderer.resize = function () {
        // Re-assert instead of resizing: a relayout must not undo the recording
        // resolution. Calling through here would also leave `_updateOverlays`
        // sized for the recording pixels rather than the on-screen canvas.
        setBackingStore();
      };
    }

    restoreCanvasSize = () => {
      if (typeof originalResize === 'function') {
        renderer.resize = originalResize;
      }
      // Restore to whatever the stage is currently displayed at, which may have
      // changed (fullscreen, a window resize) while the recording was running.
      const width = canvas.clientWidth || previousWidth / devicePixelRatio;
      const height = canvas.clientHeight || previousHeight / devicePixelRatio;
      // Go through the renderer again so overlays and render quality follow the
      // canvas back down, then re-assert the exact backing store.
      if (typeof originalResize === 'function') {
        originalResize.call(renderer, width, height);
      }
      canvas.width = Math.round(width * devicePixelRatio);
      canvas.height = Math.round(height * devicePixelRatio);
      if (renderer.dirty !== undefined) {
        renderer.dirty = true;
        renderer.draw();
      }
    };

    setBackingStore();
    // The canvas fills its container, so only the rendered pixel count grows:
    // the CSS size is untouched and fullscreen still works during recording.
    return target;
  };

  const buildStream = () => {
    const result = new MediaStream();

    const canvasStream = renderer.canvas.captureStream(FRAME_RATE);
    for (const track of canvasStream.getVideoTracks()) {
      result.addTrack(track);
    }

    const audioEngine = vm.runtime.audioEngine;
    if (audioEngine && audioEngine.audioContext) {
      // FIX: Ensure AudioContext is actively running (prevents silent audio if suspended by browser policy)
      if (audioEngine.audioContext.state === 'suspended') {
        audioEngine.audioContext.resume().catch(err => {
          console.warn('Recording addon: failed to resume AudioContext', err);
        });
      }

      if (audioEngine.inputNode) {
        audioDestination = audioEngine.audioContext.createMediaStreamDestination();
        audioEngine.inputNode.connect(audioDestination);
        for (const track of audioDestination.stream.getAudioTracks()) {
          result.addTrack(track);
        }
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
      try {
        audioDestination.disconnect();
      } catch (e) {
        // Ignore disconnection errors if already cleaned up
      }
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
    // Derive the bitrate from the canvas that is actually being captured, not
    // from the requested size: on high-DPI screens the backing store is the
    // encoded size, and an undersized bitrate makes the video visibly banded.
    const encodedWidth = renderer.canvas.width || size.width;
    const encodedHeight = renderer.canvas.height || size.height;
    recorderOptions.videoBitsPerSecond = getVideoBitrate(encodedWidth, encodedHeight, FRAME_RATE);

    // FIX: Fallback mechanism if MediaRecorder fails with advanced config options
    try {
      recorder = new MediaRecorder(stream, recorderOptions);
    } catch (error) {
      console.warn('Recording addon: failed with custom recorder options, falling back to default', error);
      try {
        recorder = new MediaRecorder(stream);
      } catch (err) {
        console.error('Recording addon: MediaRecorder instantiation failed completely', err);
        dispose();
        return;
      }
    }

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
      downloadBlob(getRecordingFilename(mimeType), blob);
      dispose();
    };
    recorder.onerror = (event) => {
      console.error('Recording addon: recorder error', event.error);
      dispose();
    };

    // FIX: Pass a timeslice of 1000ms to flush chunks regularly and prevent data corruption
    recorder.start(1000);
  };

  const stop = () => {
    if (!recorder || recorder.state === 'inactive') {
      return;
    }
    recorder.stop();
  };

  vm.runtime.on('PROJECT_START_BEFORE_RESET', () => {
    // greenFlag() runs stopAll() itself just before this, which emits
    // PROJECT_STOP_ALL. That is a restart, not the project deciding to stop.
    resettingForGreenFlag = true;
  });
  vm.runtime.on('PROJECT_START', () => {
    resettingForGreenFlag = false;
    start();
  });
  vm.runtime.on('PROJECT_STOP_ALL', () => {
    if (resettingForGreenFlag) {
      return;
    }
    // The "stop all" block (and the stop sign button) stops the project; finish
    // the recording so the part that did play still gets downloaded.
    stop();
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    // FIX: Ignore keypress if the user is typing into input fields, textareas, or editable containers
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
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
