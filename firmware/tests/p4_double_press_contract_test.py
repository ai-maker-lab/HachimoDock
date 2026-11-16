"""Package validation negotiates new double events without granting old peers them."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pc/skills/petui/scripts"))
from validate_generated_widget import validate_buttons


def test_component_double_bindings_require_advertised_capability():
    buttons = [{"action": f"game.key{sw}", "control": f"SW{sw}",
                "event": f"button.sw{sw}.double_press", "label": f"Key {sw}"}
               for sw in (1, 2, 3)]
    actions = {button["action"] for button in buttons}
    for caps, expected in (({}, 3), ({"buttonDoublePress": "p4-button-double-press-v1"}, 0)):
        errors = []
        validate_buttons(buttons, actions, caps, {}, errors)
        assert len(errors) == expected, errors
    errors = []
    validate_buttons(buttons, actions, {"buttonDoublePress": "p4-button-double-press-v1"},
                     {"input": {"hold": "game.key1"}}, errors)
    assert any("SW1" in e and "双击" in e for e in errors), errors
