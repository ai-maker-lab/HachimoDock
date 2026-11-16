/*
 * [Input] Deterministic centered and directional joystick samples.
 * [Output] Assertions for center-aware four-way hysteresis, limited-travel
 *          direction recognition, dominant-axis resolution, and held repeat.
 * [Pos] Native C regression executable for P4 input logic.
 * [Sync] If this file changes, update `p4_input_logic_test.py` and the decoder.
 */

#include "pet_p4_input_core.h"

#include <assert.h>
#include <stddef.h>

static void release_to_center(pet_p4_joystick_decoder_t *decoder) {
  assert(pet_p4_joystick_decoder_update(decoder, 2048, 2048, 5) == PET_P4_JOYSTICK_CENTER);
}

static void test_clicks(void) {
  pet_p4_button_click_t keys[3] = {0};
  const uint8_t down = PET_P4_BUTTON_EVENT_DOWN;
  const uint8_t short_press = PET_P4_BUTTON_EVENT_SHORT_PRESS;
  const uint8_t double_press = PET_P4_BUTTON_EVENT_DOUBLE_PRESS;
  for (int key = 0; key < 3; key++) {
    pet_p4_button_click_t *c = &keys[key];
    assert(pet_p4_button_click_update(c, short_press, 10, 1, false) == short_press);
    assert(!pet_p4_button_click_update(c, short_press, 100, 1, true));
    assert(!pet_p4_button_click_update(c, 0, 399, 1, true));
    assert(pet_p4_button_click_update(c, 0, 400, 1, true) == short_press);
    assert(!pet_p4_button_click_update(c, 0, 1000, 1, true));
    /* The second down reserves the pair; release emits only a double. */
    assert(!pet_p4_button_click_update(c, short_press, 1100, 1, true));
    assert(pet_p4_button_click_update(c, down, 1399, 1, true) == down);
    assert(!pet_p4_button_click_update(c, 0, 1400, 1, true));
    assert(pet_p4_button_click_update(c, short_press, 1500, 1, true) == double_press);
    /* Triple click = double followed by a single. */
    assert(!pet_p4_button_click_update(c, short_press, 1600, 1, true));
    assert(pet_p4_button_click_update(c, 0, 1900, 1, true) == short_press);
    /* A down exactly at the deadline starts an independent depression. */
    assert(!pet_p4_button_click_update(c, short_press, 2000, 1, true));
    assert(pet_p4_button_click_update(c, down, 2300, 1, true) == (down | short_press));
    assert(!pet_p4_button_click_update(c, short_press, 2350, 1, true));
    /* Ownership changes and clock rollback cancel pending clicks. */
    assert(!pet_p4_button_click_update(c, 0, 2650, 2, true));
    assert(!pet_p4_button_click_update(c, short_press, 2700, 2, true));
    assert(!pet_p4_button_click_update(c, 0, 2600, 2, true));
    /* A second depression held long cancels the pending short. */
    assert(!pet_p4_button_click_update(c, short_press, 3000, 2, true));
    assert(pet_p4_button_click_update(c, down, 3100, 2, true) == down);
    assert(pet_p4_button_click_update(c, PET_P4_BUTTON_EVENT_LONG_PRESS, 3800, 2, true)
      == PET_P4_BUTTON_EVENT_LONG_PRESS);
    assert(!pet_p4_button_click_update(c, 0, 4000, 2, true));
  }
  assert(!pet_p4_button_click_update(&keys[0], short_press, 5000, 2, true));
  assert(!pet_p4_button_click_update(&keys[1], short_press, 5100, 2, true));
  assert(pet_p4_button_click_update(&keys[0], 0, 5300, 2, true) == short_press);
  assert(!pet_p4_button_click_update(&keys[1], 0, 5300, 2, true));
  assert(pet_p4_button_click_update(&keys[1], 0, 5400, 2, true) == short_press);
}

int main(void) {
  test_clicks();
  pet_p4_input_gate_t gate={0};
  assert(pet_p4_input_gate_accept(&gate,false,1));
  assert(pet_p4_input_gate_accept(&gate,false,1));
  assert(!pet_p4_input_gate_accept(&gate,false,2));
  assert(!pet_p4_input_gate_accept(&gate,false,1)); /* cannot rearm by returning */
  assert(!pet_p4_input_gate_accept(&gate,true,2));
  assert(pet_p4_input_gate_accept(&gate,false,2));
  int center_x;
  int center_y;
  const int samples = PET_P4_JOYSTICK_CALIBRATION_SAMPLES;
  assert(pet_p4_joystick_calibrate_center(2048 * samples, 2100 * samples, samples, &center_x, &center_y));
  assert(center_x == 2048 && center_y == 2100);
  assert(!pet_p4_joystick_calibrate_center(500 * samples, 520 * samples, samples, &center_x, &center_y));
  assert(center_x == 500 && center_y == 520);
  assert(!pet_p4_joystick_calibrate_center(2048 * samples, 500 * samples, samples, &center_x, &center_y));
  assert(!pet_p4_joystick_calibrate_center(4095 * samples, 2048 * samples, samples, &center_x, &center_y));
  assert(!pet_p4_joystick_calibrate_center(2048 * (samples - 1), 2048 * (samples - 1), samples - 1, &center_x, &center_y));
  assert(!pet_p4_joystick_calibrate_center(0, 0, 0, &center_x, &center_y));
  assert(center_x == 0 && center_y == 0);
  assert(!pet_p4_joystick_calibrate_center(0, 0, samples, NULL, &center_y));
  assert(pet_p4_joystick_calibrate_center(1200 * samples, 2900 * samples, samples, &center_x, &center_y));
  pet_p4_joystick_decoder_t joystick;
  pet_p4_joystick_decoder_init(&joystick, 2048, 2048, 900, 500, 350, 140);

  assert(pet_p4_joystick_decoder_update(&joystick, 2048, 2048, 5) == PET_P4_JOYSTICK_CENTER);
  assert(pet_p4_joystick_decoder_update(&joystick, 400, 2048, 5) == PET_P4_JOYSTICK_LEFT);
  assert(pet_p4_joystick_decoder_update(&joystick, 1600, 2048, 5) == PET_P4_JOYSTICK_CENTER);
  release_to_center(&joystick);
  assert(pet_p4_joystick_decoder_update(&joystick, 3700, 2048, 5) == PET_P4_JOYSTICK_RIGHT);
  release_to_center(&joystick);
  assert(pet_p4_joystick_decoder_update(&joystick, 2048, 3700, 5) == PET_P4_JOYSTICK_UP);
  release_to_center(&joystick);
  assert(pet_p4_joystick_decoder_update(&joystick, 2048, 400, 5) == PET_P4_JOYSTICK_DOWN);
  release_to_center(&joystick);

  // Limited-travel samples from production joystick batches must cross the
  // center-aware threshold even though they do not reach the ADC rails.
  assert(pet_p4_joystick_decoder_update(&joystick, 1500, 2048, 5) == PET_P4_JOYSTICK_LEFT);
  release_to_center(&joystick);
  assert(pet_p4_joystick_decoder_update(&joystick, 2600, 2048, 5) == PET_P4_JOYSTICK_RIGHT);
  release_to_center(&joystick);
  assert(pet_p4_joystick_decoder_update(&joystick, 2048, 2600, 5) == PET_P4_JOYSTICK_UP);
  release_to_center(&joystick);
  assert(pet_p4_joystick_decoder_update(&joystick, 2048, 1500, 5) == PET_P4_JOYSTICK_DOWN);
  release_to_center(&joystick);

  // A diagonal sample resolves to the dominant axis and emits only once.
  assert(pet_p4_joystick_decoder_update(&joystick, 3500, 3100, 5) == PET_P4_JOYSTICK_RIGHT);
  assert(pet_p4_joystick_decoder_update(&joystick, 3500, 3100, 340) == PET_P4_JOYSTICK_CENTER);
  assert(pet_p4_joystick_decoder_update(&joystick, 3500, 3100, 10) == PET_P4_JOYSTICK_RIGHT);
  assert(pet_p4_joystick_decoder_update(&joystick, 3500, 3100, 140) == PET_P4_JOYSTICK_RIGHT);
  release_to_center(&joystick);

  return 0;
}
