export const AI_THINKER_PREVIEW = {
  schemaVersion: 1, profile: 'AI-Thinker ESP32-CAM · preview, not connected', soc: 'ESP32',
  channelIds: [8,9,10,11,12,13,14,15], availablePins: [13,14], outputPins: [13,14], noPullPins: [],
  modes: ['digital-input','digital-output','pwm-output'], pwmResolutionBits: 10, pwmMaxHz: 20000,
  transportSupport: { usbFramed: true, wifi: true, bluetoothSpp: true, bleImplemented: false },
};
export function normalizeCapabilities(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.profile !== 'string' || value.profile.length > 120) throw new Error('Capabilities require schemaVersion 1 and a profile name.');
  const result = structuredClone(value);
  for (const key of ['channelIds', 'availablePins', 'outputPins', 'noPullPins']) {
    if (!Array.isArray(result[key]) || result[key].length > 64 || result[key].some(n => !Number.isInteger(n) || n < 0 || n > (key === 'channelIds' ? 255 : 63)) || new Set(result[key]).size !== result[key].length) throw new Error(`Invalid ${key}.`);
  }
  if (!result.outputPins.every(p => result.availablePins.includes(p)) || !result.noPullPins.every(p => result.availablePins.includes(p))) throw new Error('Output/no-pull pins must be available inputs.');
  if (!Array.isArray(result.modes) || result.modes.some(m => !['digital-input','digital-output','pwm-output'].includes(m))) throw new Error('Invalid channel modes.');
  if (result.modes.includes('pwm-output') && (!Number.isInteger(result.pwmResolutionBits) || result.pwmResolutionBits < 1 || result.pwmResolutionBits > 16 || !Number.isInteger(result.pwmMaxHz) || result.pwmMaxHz < 1)) throw new Error('Invalid PWM limits.');
  return result;
}
export function validateDeviceRequest(request, caps) {
  if (!caps.channelIds.includes(request.id)) throw new Error('Channel ID is not advertised by the device.');
  const names = { input: 'digital-input', output: 'digital-output', pwm: 'pwm-output' };
  if (request.mode === 'disabled') return;
  if (!caps.modes.includes(names[request.mode])) throw new Error('Mode is not supported by this device.');
  if (!(request.mode === 'input' ? caps.availablePins : caps.outputPins).includes(request.pin)) throw new Error('Pin is not available for this mode.');
  if (request.mode === 'input' && request.pull !== 'none' && caps.noPullPins.includes(request.pin)) throw new Error('This pin does not provide the requested internal pull.');
  if (request.mode === 'pwm' && (!(request.frequency >= 1) || request.frequency > caps.pwmMaxHz || caps.pwmResolutionBits !== 10)) throw new Error('The v0 wire configuration requires supported 10-bit PWM and a frequency within the advertised limit.');
}
