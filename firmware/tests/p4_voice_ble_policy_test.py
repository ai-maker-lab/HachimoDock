from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_ble_only_voice_policy(tmp_path):
    source = tmp_path / 'policy.c'
    source.write_text('''#include <assert.h>
#include "pet_p4_voice_policy.h"
int main(void) {
  assert(pet_p4_voice_ble_only(true, 0, false, 100, 6000));
  assert(!pet_p4_voice_ble_only(true, 0, true, 100, 6000));
  assert(!pet_p4_voice_ble_only(false, 0, false, 100, 6000));
  assert(!pet_p4_voice_ble_only(true, 100, false, 6100, 6000));
  assert(pet_p4_voice_ble_only(true, 100, false, 6101, 6000));
  assert(!pet_p4_voice_ble_only(true, 100, true, 6101, 6000));
  assert(!pet_p4_voice_ble_only(false, 100, false, 6101, 6000));
  assert(!pet_p4_voice_ble_only(true, 200, false, 100, 6000));
  assert(!pet_p4_voice_ble_only(true, 6101, false, 6101, 6000));
}
''')
    binary = tmp_path / 'policy'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                    '-I', str(ROOT / 'main'), str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_gate_precedes_voice_actions_and_renderer_tracks_notice_retention():
    input_src = (ROOT / 'main/pet_p4_input.c').read_text()
    gate = input_src.index('state && state->ble_only_desktop && binding')
    assert gate < input_src.index('pet_p4_audio_capture_start', gate)
    assert '"voice_ptt"' in input_src[gate:gate + 500]
    assert '"realtime_chat"' in input_src[gate:gate + 500]
    assert 'send_ignored_component_event' in input_src[gate:gate + 500]
    assert 'pet_p4_ble_link_ready(' not in input_src

    renderer_src = (ROOT / 'main/pet_p4_renderer.c').read_text()
    assert 'pet_p4_ble_link_ready(' not in renderer_src
    assert 'voice_notice_visible' in renderer_src
    assert 'g_last_voice_notice_visible' in renderer_src
    assert '!approval_visible&&!voice_notice_visible' in renderer_src
