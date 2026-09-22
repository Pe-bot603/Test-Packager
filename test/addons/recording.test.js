import recording, {
  getSupportedMimeType,
  getFileExtension,
  getRecordingFilename
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

const makeScaffolding = () => {
  const handlers = {};
  const canvas = {
    captureStream: () => new FakeMediaStream([makeTrack('video')])
  };
  const audioDestination = {
    stream: new FakeMediaStream([makeTrack('audio')]),
    disconnect: jest.fn()
  };
  const vm = {
    runtime: {
      renderer: {canvas},
      audioEngine: {
        audioContext: {createMediaStreamDestination: () => audioDestination},
        inputNode: {connect: jest.fn()}
      },
      on: (event, handler) => {
        handlers[event] = handler;
      }
    }
  };
  return {scaffolding: {vm}, handlers, audioDestination};
};

let listeners;

const setupGlobals = () => {
  const store = {};
  global.MediaStream = FakeMediaStream;
  global.MediaRecorder = FakeMediaRecorder;
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
});
