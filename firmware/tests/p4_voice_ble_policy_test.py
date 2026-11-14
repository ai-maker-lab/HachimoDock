from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def test_ble_only_voice_policy():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / 'policy.c'
        source.write_text('''#include <assert.h>
#include "pet_p4_voice_policy.h"
int main(void) {
  assert(pet_p4_voice_ble_only(true, 0, 100, 6000));
  assert(!pet_p4_voice_ble_only(false, 0, 100, 6000));
  assert(!pet_p4_voice_ble_only(true, 100, 6100, 6000));
  assert(pet_p4_voice_ble_only(true, 100, 6101, 6000));
  assert(!pet_p4_voice_ble_only(false, 100, 6101, 6000));
  assert(!pet_p4_voice_ble_only(true, 200, 100, 6000));
  assert(!pet_p4_voice_ble_only(true, 6101, 6101, 6000));
}
''')
        binary = Path(tmp) / 'policy'
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                        '-I', str(ROOT / 'main'), str(source), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


def test_gate_precedes_voice_actions_and_never_queries_nimble():
    source = (ROOT / 'main/pet_p4_input.c').read_text()
    gate = source.index('state && state->ble_only_desktop && binding')
    assert gate < source.index('pet_p4_audio_capture_start', gate)
    assert '"voice_ptt"' in source[gate:gate + 500]
    assert '"realtime_chat"' in source[gate:gate + 500]
    assert 'send_ignored_component_event' in source[gate:gate + 500]
    assert 'pet_p4_ble_link_ready(' not in source
    assert 'pet_p4_ble_link_ready(' not in (ROOT / 'main/pet_p4_renderer.c').read_text()
