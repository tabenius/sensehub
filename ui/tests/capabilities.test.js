import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_THINKER_PREVIEW, normalizeCapabilities, validateDeviceRequest } from '../capabilities.js';
test('board-reported pins and modes, not SoC names, control requests', () => {
  const caps = normalizeCapabilities(AI_THINKER_PREVIEW);
  assert.doesNotThrow(() => validateDeviceRequest({ id: 8, mode: 'input', pin: 13, pull: 'up' }, caps));
  assert.throws(() => validateDeviceRequest({ id: 8, mode: 'input', pin: 25, pull: 'none' }, caps));
  const s3 = normalizeCapabilities({ ...caps, profile: 'Simulated S3 board', soc: 'ESP32-S3', availablePins: [38], outputPins: [38], noPullPins: [] });
  assert.doesNotThrow(() => validateDeviceRequest({ id: 8, mode: 'output', pin: 38 }, s3));
  const usbOnly = normalizeCapabilities({ ...caps, profile: 'Simulated USB-only board', soc: 'ESP32-H2', availablePins: [], outputPins: [], modes: [] });
  assert.throws(() => validateDeviceRequest({ id: 8, mode: 'input', pin: 13 }, usbOnly));
  assert.doesNotThrow(() => validateDeviceRequest({ id: 8, mode: 'disabled' }, usbOnly));
});
test('capability validation rejects inconsistent masks and unavailable pulls', () => {
  assert.throws(() => normalizeCapabilities({ ...AI_THINKER_PREVIEW, outputPins: [25] }));
  const caps = normalizeCapabilities({ ...AI_THINKER_PREVIEW, noPullPins: [13] });
  assert.throws(() => validateDeviceRequest({ id: 8, mode: 'input', pin: 13, pull: 'up' }, caps));
});
