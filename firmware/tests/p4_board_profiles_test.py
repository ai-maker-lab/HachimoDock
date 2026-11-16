"""Compile the hardware pin contract for the supported carrier profiles."""
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("pico,expected", [
    (0, [50, 49, 5, 4, 3, 2, 21, 20]),
    # r229-pico actual driver startup mapping, rather than its stale hello.
    (1, [14, 6, 5, 4, 3, 2, 21, 20]),
])
def test_carrier_pin_profile(tmp_path, pico, expected):
    source = tmp_path / "pins.c"
    source.write_text('''
#include <stdio.h>
#include "pet_p4_board_pins.h"
int main(void) {
  printf("%d %d %d %d %d %d %d %d\\n",
    PET_P4_INPUT_SW1_GPIO, PET_P4_INPUT_SW2_GPIO, PET_P4_INPUT_SW3_GPIO,
    PET_P4_INPUT_ENCODER_PRESS_GPIO, PET_P4_INPUT_ENCODER_B_GPIO,
    PET_P4_INPUT_ENCODER_A_GPIO, PET_P4_INPUT_JOYSTICK_X_GPIO,
    PET_P4_INPUT_JOYSTICK_Y_GPIO);
  return 0;
}
''', encoding="utf8")
    binary = tmp_path / "pins.exe"
    subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    f"-DPET_P4_BOARD_PICO={pico}", "-I", str(ROOT / "main"),
                    str(source), "-o", str(binary)], check=True, capture_output=True)
    actual = [int(n) for n in subprocess.check_output([str(binary)], text=True).split()]
    assert actual == expected
    assert len(actual) == len(set(actual))
