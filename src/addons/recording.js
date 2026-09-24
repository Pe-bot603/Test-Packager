import downloadBlob from '../scaffolding/download';

// Mantemos o H.264 (avc1) no topo para usar aceleração por hardware da placa de vídeo e remover o lag
const PREFERRED_MIME_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm'
];

// Limite seguro onde o codec de hardware (H.264) aceita codificar sem falhar
const MAX_AVC1_PIXELS = 3840 * 2160;

const isMimeTypeUsableForSize = (mimeType, width, height) => {
  if (!mimeType || mimeType.indexOf('video/mp4') !== 0) {
    return true;
  }
  if (!width || !height) {
    return true;
  }
  return width * height <= MAX_AVC1_PIXELS;
};

const getSupportedMimeType = (width, height) => {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType) && isMimeTypeUsableForSize(mimeType, width, height)) {
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

// Resoluções nativas mantidas: suporta de HD até 4K real
const RESOLUTION_HEIGHTS = {
  source: null,
  '720': 720,
  '1080': 1080,
  '1440': 1440,
  '2160': 2160
};

const DEFAULT_ASPECT_RATIO = 480 / 360;

// Reduzido ligeiramente de 0.2 para 0.15 para aliviar o processador em resoluções altas sem perder nitidez
const BITS_PER_PIXEL_PER_SECOND = 0.15;
const MIN_VIDEO_BITRATE = 8_000_000;
const MAX_VIDEO_BITRATE = 60_000_000; // Teto balanceado para evitar travamento do buffer do navegador

const getResolutionSize = (resolution, displayWidth, displayHeight) => {
  const targetHeight = RESOLUTION_HEIGHTS[resolution];
  if (!targetHeight) {
    return { width: displayWidth, height: displayHeight };
  }
  const aspectRatio = displayHeight ? displayWidth / displayHeight : DEFAULT_ASPECT_RATIO;
  const targetWidth = Math.round(targetHeight * aspectRatio);
  return {
    width: targetWidth % 2 === 0 ? targetWidth : targetWidth + 1,
    height: targetHeight
  };
};

const getVideoBitrate = (width, height, frameRate) => {
  const bitrate = Math.round(width * height * frameRate * BITS_PER_PIXEL_PER_SECOND);
  return Math.max(MIN_VIDEO_BITRATE, Math.min(MAX_VIDEO_BITRATE, bitrate));
};

// Fixado em 30 FPS para manter estabilidade total e acompanhar o motor do jogo
const FRAME_RATE = 30;

const run = ({ scaffolding, options = {} }) => {
  const vm = scaffolding.vm;

  const renderer = vm.runtime.renderer;
  if (!renderer || !renderer.canvas || typeof renderer.canvas.captureStream !== 'function') {
    console.warn('Recording addon: canvas captureStream is not supported in this browser');
    return;
  }

  if (getSupportedMimeType() === null) {
    console.warn('Recording addon: MediaRecorder is not supported in this browser');
    return;
  }

  let recorder = null;
  let stream = null;
  let chunks = [];
  let audioDestination = null;
  let restoreCanvasSize = null;
  let resettingForGreenFlag = false;

  const applyHighResolution = () => {
    const canvas = renderer.canvas;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const displayWidth = canvas.clientWidth || Math.round(canvas.width / devicePixelRatio);
    const displayHeight = canvas.clientHeight || Math.round(canvas.height / devicePixelRatio);
    const target = getResolutionSize(options.recordingResolution, displayWidth, displayHeight);

    if (!RESOLUTION_HEIGHTS[options.recordingResolution]) {
      return target;
    }

    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    const originalResize = renderer.resize;
    const setBackingStore = () => {
      if (canvas.width === target.width && canvas.height === target.height) {
        return;
      }
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
        setBackingStore();
      };
    }

    restoreCanvasSize = () => {
      if (typeof originalResize === 'function') {
        renderer.resize = originalResize;
      }
      const width = canvas.clientWidth || previousWidth / devicePixelRatio;
      const height = canvas.clientHeight || previousHeight / devicePixelRatio;
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
      } catch (e) {}
      audioDestination = null;
    }
    if (restoreCanvasSize) {
      restoreCanvasSize();
      restoreCanvasSize = null;
    }
  };

  const start = () => {
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

    const encodedWidth = renderer.canvas.width || size.width;
    const encodedHeight = renderer.canvas.height || size.height;
    const recorderMimeType = getSupportedMimeType(encodedWidth, encodedHeight);

    const recorderOptions = {};
    if (recorderMimeType) {
      recorderOptions.mimeType = recorderMimeType;
    }
    recorderOptions.videoBitsPerSecond = getVideoBitrate(encodedWidth, encodedHeight, FRAME_RATE);

    // CORREÇÃO DE COR E BRILHO: Injeta a matriz Rec. 709 para manter as cores pastéis fiéis
    recorderOptions.videoColorSpace = {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709'
    };

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
    
    const actualMimeType = recorder.mimeType || recorderMimeType;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, {type: actualMimeType || 'video/webm'});
      downloadBlob(getRecordingFilename(actualMimeType), blob);
      dispose();
    };
    recorder.onerror = (event) => {
      console.error('Recording addon: recorder error', event.error);
      dispose();
    };

    recorder.start(1000);
  };

  const stop = () => {
    if (!recorder || recorder.state === 'inactive') {
      return;
    }
    try {
      recorder.stop();
      // Força um frame fantasma para destravar o buffer de encerramento do navegador imediatamente
      if (renderer && typeof renderer.draw === 'function') {
        renderer.dirty = true;
        renderer.draw();
      }
    } catch (error) {
      console.error('Recording addon: erro ao parar', error);
      dispose();
    }
  };

  // INTERCEPTAÇÃO DO BLOCO DE PARAR DO PROJETO (Corrige a parada e download automático)
  const originalStopAll = vm.runtime.stopAll;
  if (typeof originalStopAll === 'function') {
    vm.runtime.stopAll = function (...args) {
      if (recorder && recorder.state !== 'inactive') {
        try {
          if (renderer && typeof renderer.draw === 'function') {
            renderer.dirty = true;
            renderer.draw();
          }
          stop();
        } catch (e) {
          console.error("Recording addon: falha ao interceptar stopAll", e);
        }
      }
      return originalStopAll.apply(this, args);
    };
  }

  vm.runtime.on('PROJECT_START_BEFORE_RESET', () => {
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
    if (recorder && recorder.state !== 'inactive') {
      stop();
    }
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target;
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
};export default run;
