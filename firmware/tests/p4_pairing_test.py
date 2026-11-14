"""Host checks for the board pairing chord and host timeout/reply logic."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_pairing_chord(tmp_path):
    source = tmp_path / 'chord.c'
    source.write_text(r'''
#include <assert.h>
#include <stddef.h>
#include "pet_p4_input_core.h"
int main(void) {
  pet_p4_pair_chord_t c = {0};
  for (int i=0;i<999;i++) assert(!pet_p4_pair_chord_update(&c,1,1,5));
  assert(c.latched);
  assert(pet_p4_pair_chord_update(&c,1,1,5));
  assert(!pet_p4_pair_chord_update(&c,1,1,5000));
  pet_p4_pair_chord_update(&c,0,0,5);
  assert(!c.latched);
  pet_p4_pair_chord_update(&c,1,1,4995);
  pet_p4_pair_chord_update(&c,0,1,5);
  assert(c.latched);
  assert(!pet_p4_pair_chord_update(&c,1,1,5000));
  pet_p4_pair_chord_update(&c,0,0,5);
  assert(pet_p4_pair_chord_update(&c,1,1,5000));
}
''')
    binary = tmp_path / 'chord'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(ROOT/'main'), str(ROOT/'main/pet_p4_input_core.c'), str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_pair_reply_and_timeout_on_host(tmp_path):
    source = (ROOT/'main/pet_p4_ble.c').read_text()
    reply = source[source.index('static void pair_result('):source.index('/* Inbound JSONL')]
    expiry = source[source.index('static void window_expiry_cb('):source.index('static void pair_command_cb(')]
    harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#define BLE_HS_CONN_HANDLE_NONE 65535
#define BLE_SM_IOACT_NUMCMP 4
#define BLE_ERR_REM_USER_CONN_TERM 19
#define PET_P4_PAIR_OFF 0
#define PET_P4_PAIR_COMPARE 2
#define PET_P4_PAIR_FAILED 4
#define PET_P4_PAIR_REJECTED 5
typedef int pet_p4_pair_mode_t;
struct ble_npl_event { int unused; };
struct ble_sm_io { int action; int numcmp_accept; };
typedef struct { int mode; } pet_p4_pair_snapshot_t;
static int64_t g_window_until;
static uint16_t g_numcmp_conn=BLE_HS_CONN_HANDLE_NONE, g_conn=7;
static bool g_pair_accepted;
static int mode, injected, answer, inject_rc, terminated, g_window_callout;
static void pair_ui(int m, int ms) { mode=m; (void)ms; }
static int ble_sm_inject_io(uint16_t c, struct ble_sm_io *io) {
  assert(c==7); injected++; answer=io->numcmp_accept; return inject_rc;
}
static void pet_p4_ble_pair_snapshot(pet_p4_pair_snapshot_t *s) { s->mode=mode; }
static int ble_gap_terminate(uint16_t c, int reason) {
  assert(c==7 && reason==19); terminated++; return 0;
}
static void ble_npl_callout_stop(int *c) { (void)c; }
'''
    harness += reply + expiry + r'''
int main(void) {
  g_window_until=1; mode=PET_P4_PAIR_COMPARE; g_numcmp_conn=7;
  pair_reply(true);
  assert(injected==1 && answer==1 && g_pair_accepted && g_window_until);
  assert(g_numcmp_conn==BLE_HS_CONN_HANDLE_NONE);
  pair_reply(false); assert(injected==1);
  window_expiry_cb(0);
  assert(mode==PET_P4_PAIR_FAILED && !g_window_until && !g_pair_accepted && terminated==1);
  g_window_until=1; mode=PET_P4_PAIR_COMPARE; g_numcmp_conn=7;
  window_expiry_cb(0);
  assert(injected==2 && answer==0 && mode==PET_P4_PAIR_REJECTED && !g_window_until);
  g_window_until=1; g_numcmp_conn=7; inject_rc=5;
  pair_reply(true);
  assert(!g_pair_accepted && mode==PET_P4_PAIR_FAILED && !g_window_until);
  g_window_until=1; mode=1; window_expiry_cb(0);
  assert(mode==PET_P4_PAIR_OFF && !g_window_until);
}
'''
    file = tmp_path/'host.c'
    file.write_text(harness)
    binary = tmp_path/'host'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(file), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_existing_bond_cannot_take_pairing_slot_or_evict(tmp_path):
    source = (ROOT/'main/pet_p4_ble.c').read_text()
    enc = source[source.index('    case BLE_GAP_EVENT_ENC_CHANGE:'):source.index('    case BLE_GAP_EVENT_PASSKEY_ACTION:')]
    harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#define BLE_GAP_EVENT_ENC_CHANGE 1
#define BLE_ERR_REM_USER_CONN_TERM 19
#define BLE_HS_CONN_HANDLE_NONE 65535
#define PET_P4_PAIR_FAILED 4
#define PET_P4_PAIR_SUCCESS 3
#define ESP_LOGI(...) ((void)0)
typedef struct { int id; } ble_addr_t;
struct ble_gap_conn_desc {
  struct { int encrypted, authenticated, bonded, key_size; } sec_state;
  ble_addr_t peer_id_addr;
};
struct event { int type; struct { int conn_handle, status; } enc_change; };
static struct ble_gap_conn_desc current;
static bool window, g_pair_accepted;
static int g_numcmp_conn=65535, terminated, cleared, result;
static bool pairing_window(void) { return window; }
static int ble_gap_conn_find(int c, struct ble_gap_conn_desc *d) {(void)c; *d=current; return 0;}
static int ble_gap_terminate(int c,int r) {(void)c;assert(r==19);terminated++;return 0;}
static int ble_store_util_bonded_peers(ble_addr_t *p,int *n,int max) {
  assert(max==3);p[0].id=1;p[1].id=2;*n=2;return 0;
}
static bool same_addr(ble_addr_t *a,ble_addr_t *b) {return a->id==b->id;}
static int clear_bond(ble_addr_t *p) {assert(p->id==1);cleared++;return 0;}
static void pair_result(int r) {result=r;window=false;}
static void run(struct event *event) {switch(event->type) {
'''
    # Logging macros deliberately discard arguments; preserve the clear call.
    enc = enc.replace('ESP_LOGI(TAG, "CLEAR_STALE rc=%d", clear_bond(&peers[i]));', '(void)clear_bond(&peers[i]);')
    harness += enc + r'''
}}
int main(void) {
  struct event event={.type=1,.enc_change={7,0}};
  current.sec_state.encrypted=1;current.sec_state.authenticated=1;
  current.sec_state.bonded=1;current.peer_id_addr.id=2;
  window=true;run(&event);
  assert(terminated==1 && cleared==0 && window);
  g_pair_accepted=true;run(&event);
  assert(terminated==1 && cleared==1 && result==3 && !window);
  run(&event);assert(terminated==1 && cleared==1); /* normal reconnect */
  window=true;g_pair_accepted=true;current.sec_state.authenticated=0;
  run(&event);assert(cleared==1 && window);
}
'''
    file = tmp_path/'slot.c'
    file.write_text(harness)
    binary = tmp_path/'slot'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(file), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_sampled_chord_overlay_and_release_do_not_leak(tmp_path):
    source = (ROOT/'main/pet_p4_input.c').read_text()
    sample = source[source.rindex('#if CONFIG_BT_NIMBLE_ENABLED', 0, source.index('  pet_p4_pair_chord_t pair_chord =')):source.index('    pet_p4_rotary_direction_t direction = pet_p4_rotary_decoder_update(')]
    sample = sample.replace('  pet_p4_pair_chord_t pair_chord', '  static pet_p4_pair_chord_t pair_chord').replace('  bool pair_drain', '  static bool pair_drain').replace('  uint32_t clear_held', '  static uint32_t clear_held').replace('  bool clear_sent', '  static bool clear_sent').replace('  uint32_t sw1_down_wait', '  static uint32_t sw1_down_wait').replace('  bool pair_single_owned', '  static bool pair_single_owned').replace('  while (true) {', '  {')
    harness = r'''
#include <assert.h>
#include <stddef.h>
#include "pet_p4_input_core.h"
#define CONFIG_BT_NIMBLE_ENABLED 1
#define PET_P4_INPUT_SW1_GPIO 0
#define PET_P4_INPUT_SW3_GPIO 2
#define PET_P4_INPUT_SAMPLE_MS 5
#define PET_P4_PAIR_OFF 0
#define PET_P4_PAIR_WINDOW 1
#define PET_P4_PAIR_COMPARE 2
typedef struct { int mode; } pet_p4_pair_snapshot_t;
static struct { int gpio, control; pet_p4_button_decoder_t decoder; } buttons[4];
static bool pressed[4];
static int mode, opens, clears, replies, leaked, other;
static int gpio_get_level(int pin) {return !pressed[pin];}
static void pet_p4_ble_pair_snapshot(pet_p4_pair_snapshot_t *p) {p->mode=mode;}
static void pet_p4_ble_open_pairing_window(void) {opens++;mode=1;}
static void pet_p4_ble_pair_clear_bonds(void) {clears++;mode=3;}
static void pet_p4_ble_numcmp_reply(bool a) {assert(a);replies++;}
static void queue_button_flags(int c, uint8_t f) {if(c==0||c==2)leaked+=!!f;else other+=!!f;}
static void sample(void) {
'''
    harness += sample + r'''
  }
}
static void tick(int n) {for(int i=0;i<n;i++)sample();}
int main(void) {
  for(int i=0;i<4;i++){buttons[i].gpio=i;buttons[i].control=i;pet_p4_button_decoder_init(&buttons[i].decoder,0,25,700);}
  pressed[0]=pressed[2]=1;tick(999);assert(!opens && !leaked);
  pressed[0]=0;tick(20);pressed[2]=0;tick(20);
  assert(!opens && !leaked);
  pressed[0]=1;tick(20); /* two-finger arrival skew: no early SW1 down */
  pressed[2]=1;tick(1000);assert(opens==1 && !leaked);
  pressed[0]=pressed[2]=0;tick(20);mode=0;tick(20);assert(!leaked);
  mode=2;pressed[0]=1;tick(20);pressed[0]=0;tick(20);
  assert(replies==1 && !leaked);
  mode=1;pressed[2]=1;tick(600);assert(clears==1 && !leaked);
  pressed[2]=0;tick(20);mode=0;tick(20);assert(!leaked);
  pressed[1]=1;tick(20);pressed[1]=0;tick(20);assert(other);
  pressed[0]=1;tick(200); /* An existing single-key hold retains its release. */
  pressed[2]=1;tick(1000);assert(opens==1);
  pressed[0]=pressed[2]=0;tick(20);assert(leaked);
}
'''
    file = tmp_path/'sample.c'
    file.write_text(harness)
    binary = tmp_path/'sample'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(ROOT/'main'), str(ROOT/'main/pet_p4_input_core.c'), str(file), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
