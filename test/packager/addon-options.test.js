import Packager from '../../src/packager/packager';

const makePackager = (chunks = {}) => {
  const packager = new Packager();
  Object.assign(packager.options.chunks, chunks);
  return packager;
};

test('recording resolution is omitted when recording is disabled', () => {
  const options = makePackager({recording: false}).getAddonOptions();
  expect('recordingResolution' in options).toBe(false);
});

test('recording resolution is passed through when recording is enabled', () => {
  const options = makePackager({recording: true, recordingResolution: '2160'}).getAddonOptions();
  expect(options.recordingResolution).toBe('2160');
});

test('recording resolution does not make the addons bundle load on its own', () => {
  // The default resolution string must not count as an enabled addon, otherwise
  // every packaged project would bundle the addons code.
  const packager = makePackager();
  const anyEnabled = Object.values(packager.getAddonOptions()).some((value) => value);
  expect(anyEnabled).toBe(false);
});