#pragma once
#include <stdint.h>
#include <stddef.h>

namespace sensehub {
enum Mode : uint8_t { Disabled = 0, DigitalInput = 1, DigitalOutput = 2, PwmOutput = 3 };
enum BoardProfile : uint8_t { UnsupportedBoard = 0, ClassicBench = 1, AiThinkerCam = 2 };
struct PinPolicy {
  uint64_t inputs = 0, outputs = 0, pulls = 0;
  bool pwm = false;
};
inline uint64_t pinBit(uint8_t pin) { return pin < 64 ? uint64_t(1) << pin : 0; }
inline PinPolicy profilePolicy(BoardProfile profile) {
  PinPolicy policy;
  if (profile == AiThinkerCam) {
    policy.inputs = policy.outputs = policy.pulls = pinBit(13) | pinBit(14); policy.pwm = true;
  } else if (profile == ClassicBench) {
    policy.outputs = pinBit(25) | pinBit(26) | pinBit(27) | pinBit(32) | pinBit(33);
    policy.inputs = policy.outputs | pinBit(35) | pinBit(36) | pinBit(39);
    policy.pulls = policy.outputs; policy.pwm = true;
  }
  return policy;
}
enum Error : uint8_t { Ok = 0, Invalid = 1, UnsupportedPin = 2, PinBusy = 3, ResourceBusy = 4, HardwareFailure = 5 };
struct ChannelConfig {
  uint8_t id = 8, mode = Disabled, pin = 25, pull = 0, invert = 0;
  uint16_t pollMs = 10, debounceMs = 0;
  uint8_t output = 0;
  uint32_t frequency = 0;
  uint16_t duty = 0; // 10-bit LEDC units, 0..1023
};
struct ChannelState {
  ChannelConfig config;
  uint32_t revision = 0, sequence = 0;
  uint64_t lastPoll = 0, candidateSince = 0;
  bool sampled = false, candidate = false, stable = false, valid = false;
};
struct Observation { bool raw = false, value = false, valid = false, gap = false; };

// Board masks, not a chip-wide assumption that every GPIO >=34 is input-only.
inline bool inputPin(uint8_t pin, const PinPolicy &policy) { return (policy.inputs & pinBit(pin)) != 0; }
inline bool outputPin(uint8_t pin, const PinPolicy &policy) { return (policy.outputs & pinBit(pin)) != 0; }
inline bool inputPin(uint8_t pin, BoardProfile profile = ClassicBench) { return inputPin(pin, profilePolicy(profile)); }
inline bool outputPin(uint8_t pin, BoardProfile profile = ClassicBench) { return outputPin(pin, profilePolicy(profile)); }
inline Error validate(const ChannelConfig &c, const ChannelState *states, size_t count, const PinPolicy &policy) {
  if (c.id < 8 || c.id >= 8 + count || c.mode > PwmOutput || c.pull > 2 || c.invert > 1 || c.output > 1 || c.pollMs < 1 || c.pollMs > 60000 || c.debounceMs > 60000) return Invalid;
  if (c.mode == Disabled) return Ok;
  if (!inputPin(c.pin, policy) || (c.mode != DigitalInput && !outputPin(c.pin, policy)) || (c.pull && !(policy.pulls & pinBit(c.pin))) || (c.mode == PwmOutput && !policy.pwm)) return UnsupportedPin;
  if (c.mode != DigitalInput && (c.pull || c.invert || c.debounceMs)) return Invalid;
  if (c.mode == PwmOutput ? (c.frequency < 1 || c.frequency > 20000 || c.duty > 1023 || c.output) : (c.frequency || c.duty)) return Invalid;
  for (size_t i = 0; i < count; i++) {
    const auto &other = states[i].config;
    if (other.id == c.id || other.mode == Disabled) continue;
    if (other.pin == c.pin) return PinBusy;
    if (c.mode == PwmOutput && other.mode == PwmOutput) return ResourceBusy; // one reserved LEDC channel
  }
  return Ok;
}
inline Error validate(const ChannelConfig &c, const ChannelState *states, size_t count, BoardProfile profile) {
  return validate(c, states, count, profilePolicy(profile));
}
inline void configure(ChannelState &state, const ChannelConfig &config) {
  const uint32_t revision = state.revision + 1;
  state = ChannelState{}; state.config = config; state.revision = revision;
}
inline Observation observe(ChannelState &s, bool raw, uint64_t nowUs) {
  const uint64_t interval = uint64_t(s.config.pollMs) * 1000;
  const bool gap = s.sampled && (nowUs < s.lastPoll || nowUs - s.lastPoll > interval * 2);
  const bool input = raw ^ bool(s.config.invert);
  if (!s.sampled || gap || input != s.candidate) { s.candidate = input; s.candidateSince = nowUs; }
  if (gap) s.valid = false;
  s.sampled = true; s.lastPoll = nowUs;
  if (nowUs - s.candidateSince >= uint64_t(s.config.debounceMs) * 1000) { s.stable = s.candidate; s.valid = true; }
  Observation observation; observation.raw = raw; observation.value = s.stable;
  observation.valid = s.valid; observation.gap = gap; return observation;
}
inline bool decodeConfig(const uint8_t *p, size_t n, ChannelConfig &c) {
  if (n != 16) return false;
  c.id = p[0]; c.mode = p[1]; c.pin = p[2]; c.pull = p[3]; c.invert = p[4];
  c.pollMs = uint16_t(p[5]) << 8 | p[6]; c.debounceMs = uint16_t(p[7]) << 8 | p[8]; c.output = p[9];
  c.frequency = uint32_t(p[10]) << 24 | uint32_t(p[11]) << 16 | uint32_t(p[12]) << 8 | p[13];
  c.duty = uint16_t(p[14]) << 8 | p[15]; return true;
}
} // namespace sensehub
