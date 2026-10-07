#include "../channel_core.h"
#include <assert.h>
#include <stdio.h>
#include <initializer_list>
using namespace sensehub;
int main() {
  ChannelState states[8];
  for (size_t i = 0; i < 8; i++) states[i].config.id = 8 + i;
  ChannelConfig c; c.mode = DigitalInput; c.debounceMs = 20;
  assert(validate(c, states, 8, ClassicBench) == Ok);
  assert(validate(c, states, 8, UnsupportedBoard) == UnsupportedPin);
  assert(validate(c, states, 8, AiThinkerCam) == UnsupportedPin);
  c.pin = 13; assert(validate(c, states, 8, AiThinkerCam) == Ok);
  c.pin = 14; assert(validate(c, states, 8, AiThinkerCam) == Ok);
  for (uint8_t pin : {0, 2, 4, 12, 15, 16, 25, 34}) { c.pin = pin; assert(validate(c, states, 8, AiThinkerCam) == UnsupportedPin); }
  c.pin = 34; assert(validate(c, states, 8, ClassicBench) == UnsupportedPin);
  c.pin = 35; c.pull = 1; assert(validate(c, states, 8, ClassicBench) == UnsupportedPin);
  c.pull = 0; assert(validate(c, states, 8, ClassicBench) == Ok);
  c.pin = 25; configure(states[0], c);
  c.id = 9; assert(validate(c, states, 8, ClassicBench) == PinBusy);
  c.pin = 26; c.mode = PwmOutput; c.debounceMs = 0; c.frequency = 1000; c.duty = 512;
  assert(validate(c, states, 8, ClassicBench) == Ok); configure(states[1], c);
  c.id = 10; c.pin = 27; assert(validate(c, states, 8, ClassicBench) == ResourceBusy);
  c.mode = DigitalOutput; c.frequency = 0; c.duty = 0; assert(validate(c, states, 8, ClassicBench) == Ok);
  c.mode = PwmOutput; c.frequency = 0; assert(validate(c, states, 8, ClassicBench) == Invalid);
  auto &s = states[0];
  assert(!observe(s, false, 1000).valid);
  assert(!observe(s, true, 11000).valid);
  assert(!observe(s, false, 21000).valid);
  assert(!observe(s, false, 31000).valid);
  auto o = observe(s, false, 41000); assert(o.valid && !o.value);
  assert(!observe(s, true, 51000).value);
  assert(!observe(s, true, 61000).value);
  assert(observe(s, true, 71000).value);
  o = observe(s, true, 200000); assert(o.gap && !o.valid); // lost continuity is not LOW
  assert(!observe(s, true, 210000).valid);
  assert(observe(s, true, 220000).valid);
  c = ChannelConfig{}; c.mode = DigitalInput; c.invert = 1; configure(s, c);
  o = observe(s, false, 100); assert(o.raw == false && o.value && o.valid);
  const uint8_t wire[16] = {8,1,25,0,1,0,10,0,20,0,0,0,0,0,0,0};
  assert(decodeConfig(wire, 16, c) && c.pollMs == 10 && c.debounceMs == 20 && c.invert);
  assert(!decodeConfig(wire, 15, c));
  // Nonclassic policies can admit output/pulls above GPIO33 (e.g. S3).
  PinPolicy custom; custom.inputs = custom.outputs = custom.pulls = pinBit(38); custom.pwm = true;
  c = ChannelConfig{}; c.pin = 38; c.mode = DigitalInput; c.pull = 1;
  assert(validate(c, states, 8, custom) == Ok);
  c.mode = DigitalOutput; c.pull = 0; assert(validate(c, states, 8, custom) == Ok);
  c.mode = PwmOutput; c.frequency = 1000; c.duty = 512;
  custom.pwm = false; assert(validate(c, states, 8, custom) == UnsupportedPin);
  c.pin = 64; assert(validate(c, states, 8, custom) == UnsupportedPin);
  PinPolicy empty; c.pin = 10; c.mode = DigitalInput; c.frequency = 0; c.duty = 0;
  assert(validate(c, states, 8, empty) == UnsupportedPin);
  puts("Channel core checks passed: profile, conflicts, PWM budget, debounce, gaps, polarity and wire decoding.");
}
