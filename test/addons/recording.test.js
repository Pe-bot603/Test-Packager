import recording, {
  getSupportedMimeType,
  getFileExtension,
  getRecordingFilename,
  getResolutionSize,
  getVideoBitrate
} from '../../src/addons/recording';

jest.mock('../../src/scaffolding/download', () => jest.fn());

import downloadBlob from '../../src/scaffolding/download';

const makeTrack = (kind) => ({kind, stop: jest.fn()});

class FakeMediaStream {
  constructor () {
    this.tracks = [];
  }
  addTrack (track) {
    this.tracks.push(track);
  }
  getTracks () {
    return this.tracks;
  }
  getVideoTracks () {
    return this.tracks.filter((i) => i.kind === 'video');
  }
  getAudioTracks () {
    return this.tracks.filter((i) => i.kind === 'audio');
  }
}

class FakeMediaRecorder {
  constructor (stream, options) {
    this.stream = stream;
    this.mimeType = options && options.mimeType;
    this.options = options;
    this.state = 'inactive';
    this.started = 0;
    this.stopped = 0;
    FakeMediaRecorder.instances.push(this);
  }
  start () {
    this.state = 'recording';
    this.started++;
  }
  stop () {
    this.state = 'inactive';
    this.stopped++;
    if (this.ondataavailable) {
      this.ondataavailable({data: new Blob(['hello'])});
    }
    if (this.onstop) this.onstop();
  }
}
FakeMediaRecorder.instances = [];
FakeMediaRecorder.isTypeSupported = (type) => type === 'video/webm';

const makeScaffolding = ({nativeSize = [480, 360]} = {}) => {
  const handlers = {};
  const canvas = {
    width: nativeSize[0],
    height: nativeSize[1],
    clientWidth: 480,
    clientHeight: 360,
    style: {},
    captureStream: () => new FakeMediaStream([makeTrack('video')])
  };
  const renderer = {
    canvas,
    _nativeSize: nativeSize,
    resizeCalls: [],
    resize (w, h) {
      // The addon may wrap and restore this function, so record calls on the
      // object itself rather than relying on a mock.
      renderer.resizeCalls.push([w, h]);
      canvas.width = w;
      canvas.height = h;
    }
  };
  const audioDestination = {
    stream: new FakeMediaStream([makeTrack('audio')]),
    disconnect: jest.fn()
  };
  const vm = {
    runtime: {
      renderer,
      audioEngine: {
        audioContext: {createMediaStreamDestination: () => audioDestination},
        inputNode: {connect: jest.fn()}
      },
      on: (event, handler) => {
        handlers[event] = handler;
      }
    }
  };
  return {scaffolding: {vm}, handlers, audioDestination, renderer, canvas};
};

let listeners;

const setupGlobals = () => {
  const store = {};
  global.MediaStream = FakeMediaStream;
  global.MediaRecorder = FakeMediaRecorder;
  global.window = {devicePixelRatio: 1};
  global.Blob = class Blob {
    constructor (parts, options) {
      this.parts = parts;
      this.type = options && options.type;
    }
  };
  global.document = {
    title: 'My Project',
    body: {},
    addEventListener: (event, handler) => {
      store[event] = handler;
    }
  };
  return store;
};

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  downloadBlob.mockClear();
  listeners = setupGlobals();
});

afterEach(() => {
  delete global.MediaStream;
  delete global.MediaRecorder;
  delete global.document;
  delete global.window;
});

describe('helpers', () => {
  test('getFileExtension', () => {
    expect(getFileExtension('video/webm')).toBe('webm');
    expect(getFileExtension('video/webm;codecs=vp9')).toBe('webm');
    expect(getFileExtension('video/mp4;codecs=avc1')).toBe('mp4');
    expect(getFileExtension('')).toBe('webm');
  });

  test('getRecordingFilename', () => {
    expect(getRecordingFilename('video/webm')).toBe('My Project.webm');
    expect(getRecordingFilename('video/mp4')).toBe('My Project.mp4');
  });

  test('getSupportedMimeType prefers the first supported type', () => {
    global.MediaRecorder = {
      isTypeSupported: (type) => type === 'video/mp4' || type === 'video/webm'
    };
    expect(getSupportedMimeType()).toBe('video/mp4');
  });

  test('getSupportedMimeType returns empty string when none supported', () => {
    global.MediaRecorder = {isTypeSupported: () => false};
    expect(getSupportedMimeType()).toBe('');
  });

  test('getSupportedMimeType returns null when unavailable', () => {
    delete global.MediaRecorder;
    expect(getSupportedMimeType()).toBe(null);
  });

  test('getResolutionSize keeps the stage size for "source"', () => {
    expect(getResolutionSize('source', 480, 360)).toEqual({width: 480, height: 360});
    expect(getResolutionSize(undefined, 480, 360)).toEqual({width: 480, height: 360});
  });

  test('getResolutionSize scales to the requested height preserving aspect ratio', () => {
    expect(getResolutionSize('1080', 480, 360)).toEqual({width: 1440, height: 1080});
    expect(getResolutionSize('2160', 480, 360)).toEqual({width: 2880, height: 2160});
  });

  test('getResolutionSize follows the on-screen aspect ratio', () => {
    // A stretched/fullscreen stage should record without distortion.
    expect(getResolutionSize('1080', 1600, 900)).toEqual({width: 1920, height: 1080});
  });

  test('getResolutionSize keeps dimensions even for odd aspect ratios', () => {
    const size = getResolutionSize('1080', 481, 361);
    expect(size.height).toBe(1080);
    expect(size.width % 2).toBe(0);
  });

  test('getVideoBitrate scales with pixels and stays within bounds', () => {
    expect(getVideoBitrate(480, 360, 30)).toBe(8_000_000);
    expect(getVideoBitrate(1920, 1080, 30)).toBe(Math.round(1920 * 1080 * 30 * 0.2));
    expect(getVideoBitrate(3840, 2160, 30)).toBe(49_766_400);
  });
});

describe('run', () => {
  test('does nothing when MediaRecorder is unavailable', () => {
    delete global.MediaRecorder;
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});
    expect(handlers.PROJECT_START).toBeUndefined();
  });

  test('records from flag until the 1 key is pressed', () => {
    const {scaffolding, handlers, audioDestination} = makeScaffolding();
    recording({scaffolding});

    expect(typeof handlers.PROJECT_START).toBe('function');
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    handlers.PROJECT_START();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder.state).toBe('recording');
    expect(recorder.mimeType).toBe('video/webm');

    listeners.keydown({key: '1', target: global.document});
    expect(recorder.state).toBe('inactive');
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0][0]).toBe('My Project.webm');
    expect(downloadBlob.mock.calls[0][1].type).toBe('video/webm');
    expect(audioDestination.disconnect).toHaveBeenCalled();
    for (const track of recorder.stream.getTracks()) {
      expect(track.stop).toHaveBeenCalled();
    }
  });

  test('does not start while a recording is already running', () => {
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});
    handlers.PROJECT_START();
    handlers.PROJECT_START();
    handlers.PROJECT_START();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  test('ignores the 1 key while typing in an input', () => {
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});
    handlers.PROJECT_START();
    const recorder = FakeMediaRecorder.instances[0];
    listeners.keydown({key: '1', target: {}});
    expect(recorder.state).toBe('recording');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  test('keeps recording when a key other than 1 is pressed', () => {
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});
    handlers.PROJECT_START();
    const recorder = FakeMediaRecorder.instances[0];
    listeners.keydown({key: '2', keyCode: 50, target: global.document});
    expect(recorder.state).toBe('recording');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  test('requests a high bitrate so recordings are not visibly banded', () => {
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding, options: {recordingResolution: '1080'}});
    handlers.PROJECT_START();
    const recorder = FakeMediaRecorder.instances[0];
    // The default MediaRecorder bitrate is far below this and causes banding.
    expect(recorder.options.videoBitsPerSecond).toBe(getVideoBitrate(1440, 1080, 30));
    expect(recorder.options.videoBitsPerSecond).toBeGreaterThan(8_000_000);
  });

  test('renders at the requested resolution while recording, then restores it', () => {
    const {scaffolding, handlers, renderer, canvas} = makeScaffolding();
    recording({scaffolding, options: {recordingResolution: '2160'}});
    handlers.PROJECT_START();

    expect(renderer.resizeCalls).toContainEqual([2880, 2160]);
    expect(canvas.width).toBe(2880);
    expect(canvas.height).toBe(2160);

    listeners.keydown({key: '1', target: global.document});
    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(360);
  });

  test('leaves the canvas size alone for the "source" resolution', () => {
    const {scaffolding, handlers, renderer, canvas} = makeScaffolding();
    recording({scaffolding, options: {recordingResolution: 'source'}});
    handlers.PROJECT_START();
    expect(renderer.resizeCalls).toHaveLength(0);
    expect(canvas.width).toBe(480);
    listeners.keydown({key: '1', target: global.document});
    expect(canvas.width).toBe(480);
  });

  test('records at the requested size on a high-DPI display', () => {
    const {scaffolding, handlers, canvas} = makeScaffolding();
    global.window = {devicePixelRatio: 2};
    try {
      recording({scaffolding, options: {recordingResolution: '1080'}});
      handlers.PROJECT_START();
      // The renderer would size the backing store to 2880x2160; the recording
      // must still produce exactly 1440x1080.
      expect(canvas.width).toBe(1440);
      expect(canvas.height).toBe(1080);
    } finally {
      delete global.window;
    }
  });

  test('restores the canvas size when starting a new recording after one finished', () => {
    const {scaffolding, handlers, renderer, canvas} = makeScaffolding();
    recording({scaffolding, options: {recordingResolution: '1080'}});

    handlers.PROJECT_START();
    expect(canvas.width).toBe(1440);
    listeners.keydown({key: '1', target: global.document});
    expect(canvas.width).toBe(480);

    handlers.PROJECT_START();
    expect(canvas.width).toBe(1440);
    expect(renderer.resizeCalls).toEqual([[1440, 1080], [480, 360], [1440, 1080]]);
  });

  test('keeps the recording resolution when the stage is relaid out mid-recording', () => {
    // Regression: a relayout used to shrink the canvas back to the on-screen
    // size, so a "4K" recording quietly came out at the window resolution.
    const {scaffolding, handlers, renderer, canvas} = makeScaffolding();
    recording({scaffolding, options: {recordingResolution: '2160'}});
    handlers.PROJECT_START();
    expect(canvas.width).toBe(2880);

    // A window resize / fullscreen / loading screen going away.
    renderer.resize(1420, 1065);
    expect(canvas.width).toBe(2880);
    expect(canvas.height).toBe(2160);

    renderer.resize(1920, 1080);
    expect(canvas.width).toBe(2880);
    expect(canvas.height).toBe(2160);
  });

  test('goes back to following relayouts once the recording ends', () => {
    const {scaffolding, handlers, renderer, canvas} = makeScaffolding();
    recording({scaffolding, options: {recordingResolution: '2160'}});
    handlers.PROJECT_START();
    listeners.keydown({key: '1', target: global.document});
    expect(canvas.width).toBe(480);

    // The renderer's resize must be restored, not left pinned.
    renderer.resize(640, 480);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
  });

  test('stops the recording when the stop all block runs', () => {
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});
    handlers.PROJECT_START();
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder.state).toBe('recording');

    handlers.PROJECT_STOP_ALL();
    expect(recorder.state).toBe('inactive');
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  test('does not stop on the stop all that a green flag runs internally', () => {
    // greenFlag() calls stopAll() before PROJECT_START, which emits
    // PROJECT_STOP_ALL. That must not be treated as the stop all block.
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});

    handlers.PROJECT_START_BEFORE_RESET();
    handlers.PROJECT_STOP_ALL();
    handlers.PROJECT_START();

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  test('still stops on a stop all block after a green flag', () => {
    const {scaffolding, handlers} = makeScaffolding();
    recording({scaffolding});

    handlers.PROJECT_START_BEFORE_RESET();
    handlers.PROJECT_STOP_ALL();
    handlers.PROJECT_START();
    const recorder = FakeMediaRecorder.instances[0];

    // The project itself runs "stop all".
    handlers.PROJECT_STOP_ALL();
    expect(recorder.state).toBe('inactive');
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });
});
