'use strict';

// Subscribe before starting capture so the first decoded frames cannot be lost.
// Every completion path releases listeners and the timeout.
function waitForCameraFrames(camera, { count = 12, timeoutMs = 15000, onProgress = () => {} } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('Frame count must be a positive integer.');
  return new Promise((resolve, reject) => {
    let received = 0;
    const cleanup = () => {
      clearTimeout(timeout);
      camera.off('frame', onFrame); camera.off('capture-error', onError); camera.off('closed', onClosed);
    };
    const onError = error => { cleanup(); reject(error); };
    const onClosed = () => onError(new Error('Camera stopped during initialization.'));
    const onFrame = () => {
      onProgress(++received / count);
      if (received >= count) { cleanup(); resolve(); }
    };
    const timeout = setTimeout(() => onError(new Error('Camera initialization timed out while waiting for frames.')), timeoutMs);
    camera.on('frame', onFrame); camera.once('capture-error', onError); camera.once('closed', onClosed);
  });
}
module.exports = { waitForCameraFrames };
