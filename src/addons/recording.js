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

const run = ({ scaffolding }) => {
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

  const buildStream = () => {
    const result = new MediaStream();

    const canvasStream = renderer.canvas.captureStream();
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
  };

  const start = () => {
    // A new green flag must not interrupt an already running recording.
    if (recorder) {
      return;
    }

    try {
      stream = buildStream();
    } catch (error) {
      console.error('Recording addon: failed to start recording', error);
      dispose();
      return;
    }

    recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined);
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
  getRecordingFilename
};

export default run;
