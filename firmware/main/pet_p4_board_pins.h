/* Physical carrier pins shared by the input driver and hello capabilities.
 * Pico mapping was read from the installed r229-pico driver's startup log;
 * that release's hello still advertised the older WiFi6 SW1/SW2 values.
 */
#pragma once

#ifndef PET_P4_BOARD_PICO
#define PET_P4_BOARD_PICO 0
#endif

#if PET_P4_BOARD_PICO
#define PET_P4_INPUT_SW1_GPIO 14
#define PET_P4_INPUT_SW2_GPIO 6
#else
#define PET_P4_INPUT_SW1_GPIO 50
#define PET_P4_INPUT_SW2_GPIO 49
#endif

#define PET_P4_INPUT_SW3_GPIO 5
#define PET_P4_INPUT_ENCODER_PRESS_GPIO 4
#define PET_P4_INPUT_ENCODER_B_GPIO 3
#define PET_P4_INPUT_ENCODER_A_GPIO 2
#define PET_P4_INPUT_JOYSTICK_X_GPIO 21
#define PET_P4_INPUT_JOYSTICK_Y_GPIO 20
