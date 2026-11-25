from pathlib import Path
import os
import shutil
import subprocess
import sys

import pytest


FIRMWARE = Path(__file__).resolve().parents[1]
SKILL = FIRMWARE.parent / "pc/skills/petui"


def test_bounded_codex_daily_usage(tmp_path):
    compiler = os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc")
    if not compiler:
        pytest.skip("C compiler unavailable")
    vendor = FIRMWARE / "tests/vendor/cjson"
    binary = tmp_path / "usage-test.exe"
    subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(FIRMWARE / "main"), "-I", str(vendor),
                    str(FIRMWARE / "tests/p4_codex_usage_test.c"), str(vendor / "cJSON.c"),
                    "-lm", "-o", str(binary)], check=True, timeout=60)
    subprocess.run([str(binary)], check=True, timeout=30)


def test_codex_usage_wasm_probe(tmp_path):
    clang = os.environ.get("HACHI_CLANG") or shutil.which("clang")
    linker = os.environ.get("HACHI_WASM_LD") or shutil.which("wasm-ld")
    node = shutil.which("node")
    if not clang or not linker or not node:
        pytest.skip("WASM compiler/linker and Node are required")
    wasm = tmp_path / "codex-usage.wasm"
    subprocess.run([sys.executable, str(SKILL / "scripts/compile_wasm.py"),
                    str(FIRMWARE / "tests/p4_codex_usage_probe.c"), str(SKILL / "sdk"),
                    clang, linker, str(wasm)], check=True, timeout=90)
    subprocess.run([node, "--input-type=module", "-e", '''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const labels = [];
const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[1]), {
  hachi: { canvas640() {}, rect() {}, text(_x, _y, _px, _rgb, address, length) {
    labels.push(new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, address, length)));
  } },
});
const { hachi_init, hachi_event, hachi_frame } = instance.exports;
hachi_init();
function screen(expected) {
  labels.length = 0;
  hachi_frame(33);
  assert.deepEqual(labels, ['CODEX / TODAY', expected]);
}
screen('NO FRESH SAMPLE');
hachi_event(4, 0, 0);
screen('NO FRESH SAMPLE');
hachi_event(32, 0, 0);
screen('0');
hachi_event(32, 2147483647, 4194303);
screen('9007199254740991');
hachi_event(32, 0, -1);
screen('NO FRESH SAMPLE');
''', str(wasm)], check=True, timeout=30)


def test_signed_codex_usage_updates(tmp_path):
    compiler = os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc")
    node = shutil.which("node")
    include = os.environ.get("HACHI_MBEDTLS_INCLUDE")
    library = os.environ.get("HACHI_MBEDCRYPTO_LIB")
    if not all((compiler, node, include, library)):
        pytest.skip("C compiler, Node, and host Mbed TLS include/static library paths required")
    verifier = tmp_path / "codex-auth-verify.exe"
    subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", include,
                    "-I", str(FIRMWARE / "main"), str(FIRMWARE / "tests/p4_codex_auth_verify.c"),
                    library, "-o", str(verifier)], check=True, timeout=60)
    subprocess.run([node, "--input-type=module", "-e", '''
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [verifier, directory] = process.argv.slice(1);
const fishing = 'token-fishing-arcade', voyage = 'token-ocean-voyage', atlas = 'token-world-atlas';
const trusted = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const other = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const toHex = key => {
  const { x, y } = key.export({format: 'jwk'});
  return Buffer.concat([Buffer.of(4), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('hex');
};
const publicHex = toHex(trusted.publicKey);
const module = value => Buffer.of(0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0, 10,6,1,4,0,65,value,11);
const section = Buffer.from('hachi.codex-use.v1');
const signed = (binary, id, signer = trusted) => {
  const message = Buffer.concat([Buffer.from(`hachi/codex-usage/v1\\0${id}\\0`), binary]);
  const signature = sign('sha256', message, {key: signer.privateKey, dsaEncoding: 'ieee-p1363'});
  return Buffer.concat([binary, Buffer.of(0, section.length + 65, section.length), section, signature]);
};
const verify = (description, binary, expected, id = fishing, policy = '0', radio = '0', key = publicHex) => {
  const path = join(directory, 'module.wasm');
  writeFileSync(path, binary);
  const {status, error, stderr} = spawnSync(verifier, [key, id, path, policy, radio], {encoding: 'utf8'});
  assert.ifError(error);
  assert.equal(status, expected ? 0 : 1, `${description}: ${stderr}`);
};

const original = signed(module(1), fishing);
const upgrade = signed(module(2), fishing);
assert(WebAssembly.validate(original) && WebAssembly.validate(upgrade));
verify('current signed module', original, true);
verify('changed module with the same key', upgrade, true);
verify('second allowed component', signed(module(3), voyage), true, voyage);
const atlasModule = signed(module(4), atlas);
verify('signed Atlas component', atlasModule, true, atlas);
verify('Atlas signature cannot authorize Voyage', atlasModule, false, voyage);
verify('unsigned Atlas component', module(4), false, atlas);
verify('different allowed ID', original, false, voyage);
verify('unlisted ID with valid signature', signed(module(1), 'other-widget'), false, 'other-widget');
verify('network policy excluded', original, false, fishing, '1');
verify('radio excluded', original, false, fishing, '0', '1');
verify('unsigned component', module(1), false);
verify('truncated signature', original.subarray(0, -1), false);
verify('unknown signing key', signed(module(1), fishing, other), false);
verify('wrong trusted public key', original, false, fishing, '0', '0', toHex(other.publicKey));
verify('invalid public point', original, false, fishing, '0', '0', '04' + '00'.repeat(64));
const tampered = Buffer.from(original);
tampered[module(1).length - 2] = 2;
assert(WebAssembly.validate(tampered));
verify('edited code with reused signature', tampered, false);
verify('extra bytes appended after the signature', Buffer.concat([original, Buffer.of(0, 1, 0)]), false);
''', str(verifier), str(tmp_path)], check=True, timeout=30)
