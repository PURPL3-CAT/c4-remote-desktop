import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType


class FakeInput(ModuleType):
    def __init__(self, name):
        super().__init__(name)
        self.calls = []
        self.PAUSE = None
        self.FAILSAFE = False

    def keyDown(self, key):
        self.calls.append(("keyDown", key))

    def keyUp(self, key):
        self.calls.append(("keyUp", key))

    def mouseDown(self, button):
        self.calls.append(("mouseDown", button))

    def mouseUp(self, button):
        self.calls.append(("mouseUp", button))

    def moveRel(self, dx, dy):
        self.calls.append(("moveRel", dx, dy))


class FakePyAutoGUI(ModuleType):
    def __init__(self):
        super().__init__("pyautogui")
        self.calls = []

    def scroll(self, amount):
        self.calls.append(("scroll", amount))


fake_input = FakeInput("pydirectinput")
fake_pyautogui = FakePyAutoGUI()
sys.modules["pydirectinput"] = fake_input
sys.modules["pyautogui"] = fake_pyautogui

module_path = Path(__file__).resolve().parents[1] / "c4-input.py"
spec = importlib.util.spec_from_file_location("c4_input", module_path)
c4_input = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c4_input)


class InputSafetyTests(unittest.TestCase):
    def setUp(self):
        fake_input.calls.clear()
        fake_pyautogui.calls.clear()
        c4_input.pressed_mods.clear()
        c4_input.pressed_keys.clear()
        c4_input.pressed_buttons.clear()
        c4_input.mouse_acc["dx"] = 0
        c4_input.mouse_acc["dy"] = 0
        c4_input.wheel_acc["delta"] = 0

    def test_session_end_releases_pressed_keys_and_buttons(self):
        c4_input.handle({
            "kind": "keydown", "key": "a", "code": "KeyA",
            "ctrl": False, "alt": False, "shift": False, "meta": False
        })
        c4_input.handle({"kind": "mousedown", "button": 0})
        c4_input.handle({"kind": "session-end"})

        self.assertIn(("keyUp", "a"), fake_input.calls)
        self.assertIn(("mouseUp", "left"), fake_input.calls)
        self.assertFalse(c4_input.pressed_keys)
        self.assertFalse(c4_input.pressed_buttons)

    def test_fail_safe_is_enabled_and_invalid_pointer_values_are_ignored(self):
        self.assertTrue(fake_input.FAILSAFE)
        c4_input.handle({"kind": "mousedown", "button": 99})
        c4_input.handle({
            "kind": "mousemove", "relative": True,
            "dx": float("inf"), "dy": 0
        })
        self.assertEqual(fake_input.calls, [])

    def test_input_events_are_not_written_to_a_log(self):
        log_path = module_path.parent / "c4-latest.log"
        before = log_path.stat() if log_path.exists() else None
        c4_input.handle({
            "kind": "keydown", "key": "x", "code": "KeyX",
            "ctrl": False, "alt": False, "shift": False, "meta": False
        })
        after = log_path.stat() if log_path.exists() else None
        self.assertEqual(
            None if before is None else (before.st_size, before.st_mtime_ns),
            None if after is None else (after.st_size, after.st_mtime_ns)
        )


if __name__ == "__main__":
    unittest.main()
