#!/usr/bin/env python3
import sys
import json
import time
import atexit
import math

import pydirectinput
import pyautogui

# SAFER DEFAULTS
pydirectinput.PAUSE = 0
pydirectinput.FAILSAFE = True

# DirectInput-safe keys (letters + digits)
DIRECT_KEYS = {
    **{f"Key{chr(c)}": chr(c).lower() for c in range(ord("A"), ord("Z")+1)},
    **{f"Digit{d}": str(d) for d in range(10)},
    **{f"Numpad{d}": f"num{d}" for d in range(10)},
}

# Physical punctuation → character fallback
PUNCT_CODES = {
    "Comma": ",",
    "Period": ".",
    "Slash": "/",
    "Semicolon": ";",
    "Quote": "'",
    "BracketLeft": "[",
    "BracketRight": "]",
    "Backslash": "\\",
    "Minus": "-",
    "Equal": "=",
    "Backquote": "`",
    "Backtick": "`",
    "IntlBackquote": "`",
}

# Physical non-punctuation keys
SPECIAL_KEYS = {
    "Space": "space",
    "Enter": "enter",
    "NumpadEnter": "enter",
    "Tab": "tab",
    "Backspace": "backspace",
    "Escape": "escape",
    "Delete": "delete",
    "Insert": "insert",
    "Home": "home",
    "End": "end",
    "PageUp": "pageup",
    "PageDown": "pagedown",
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    **{f"F{i}": f"f{i}" for i in range(1, 13)},
}

MODIFIERS = {
    "ShiftLeft": "shift",
    "ShiftRight": "shift",
    "ControlLeft": "ctrl",
    "ControlRight": "ctrl",
    "AltLeft": "alt",
    "AltRight": "alt",
    "MetaLeft": "win",
    "MetaRight": "win",
}

pressed_mods = set()
pressed_keys = set()
pressed_buttons = set()

mouse_acc = {"dx": 0, "dy": 0, "last": time.perf_counter()}
wheel_acc = {"delta": 0, "last": time.perf_counter()}
ACCUM = 0.0  # No accumulation delay — flush input immediately for maximum responsiveness


def report_error(error):
    print(json.dumps({"error": str(error)}), file=sys.stderr, flush=True)


def press_mod(code):
    name = MODIFIERS.get(code)
    if name and code not in pressed_mods:
        pressed_mods.add(code)
        pydirectinput.keyDown(name)


def release_mod(code):
    name = MODIFIERS.get(code)
    if name and code in pressed_mods:
        pressed_mods.remove(code)
        pydirectinput.keyUp(name)


def release_all_mods():
    for code in list(pressed_mods):
        try:
            release_mod(code)
        except Exception as ex:
            report_error(ex)
    pressed_mods.clear()


def release_all():
    release_all_mods()
    for key in list(pressed_keys):
        try:
            pydirectinput.keyUp(key)
        except Exception as ex:
            report_error(ex)
            release_all()
        pressed_keys.discard(key)
    for button in list(pressed_buttons):
        try:
            pydirectinput.mouseUp(button=button)
        except Exception as ex:
            report_error(ex)
        pressed_buttons.discard(button)
    mouse_acc["dx"] = mouse_acc["dy"] = 0
    wheel_acc["delta"] = 0


atexit.register(release_all)


def is_synthetic_symbol(e):
    key = e.get("key")
    code = e.get("code")
    if not key or not code:
        return False
    if code in PUNCT_CODES and len(key) > 1:
        return True
    return False


def resolve_key(code, key):
    if code in MODIFIERS:
        return ("modifier", MODIFIERS[code])

    if code in DIRECT_KEYS:
        return ("direct", DIRECT_KEYS[code])

    if code in SPECIAL_KEYS:
        return ("special", SPECIAL_KEYS[code])

    if code in PUNCT_CODES:
        return ("char", PUNCT_CODES[code])

    if isinstance(key, str) and len(key) == 1 and key.isalnum():
        return ("direct", key.lower())

    return ("ignore", "")


def flush_mouse():
    dx = mouse_acc["dx"]
    dy = mouse_acc["dy"]
    if dx or dy:
        pydirectinput.moveRel(int(dx), int(dy))
        mouse_acc["dx"] = mouse_acc["dy"] = 0
    mouse_acc["last"] = time.perf_counter()


def flush_wheel():
    delta = wheel_acc["delta"]
    if delta:
        pyautogui.scroll(delta)
        wheel_acc["delta"] = 0
    wheel_acc["last"] = time.perf_counter()


def wheel_delta_to_clicks(delta, delta_mode):
    if isinstance(delta, bool) or not isinstance(delta, (int, float)) or not math.isfinite(delta):
        return 0
    d = max(-10_000.0, min(10_000.0, float(delta)))

    if delta_mode == 0:
        clicks = d / 120.0
    elif delta_mode == 1:
        clicks = d
    elif delta_mode == 2:
        clicks = d * 10
    else:
        clicks = d / 120.0

    clicks = -clicks
    return int(round(clicks * 3))


def handle(e):
    if not isinstance(e, dict):
        return
    kind = e.get("kind")
    now = time.perf_counter()

    # Emergency kill: Ctrl+K
    if kind in ("keydown", "keyup"):
        if e.get("ctrl") is True and (e.get("key") or "").lower() == "k":
            release_all()
            sys.exit(0)

    # Session end from Electron
    if kind == "session-end":
        release_all()
        return

    if kind == "mousemove":
        if e.get("relative") is not True:
            return
        dx = e.get("dx", 0)
        dy = e.get("dy", 0)
        if (isinstance(dx, bool) or not isinstance(dx, (int, float)) or not math.isfinite(dx) or
                isinstance(dy, bool) or not isinstance(dy, (int, float)) or not math.isfinite(dy)):
            return
        mouse_acc["dx"] = max(-10_000, min(10_000, mouse_acc["dx"] + int(max(-10_000, min(10_000, dx)))))
        mouse_acc["dy"] = max(-10_000, min(10_000, mouse_acc["dy"] + int(max(-10_000, min(10_000, dy)))))
        flush_mouse()
        return

    if kind == "wheel":
        raw = e.get("delta", 0)
        mode = e.get("deltaMode", 0)
        if isinstance(mode, bool) or not isinstance(mode, int) or mode not in (0, 1, 2):
            return
        wheel_acc["delta"] += wheel_delta_to_clicks(raw, mode)
        wheel_acc["delta"] = max(-300, min(300, wheel_acc["delta"]))
        flush_wheel()
        return

    try:
        flush_mouse()
        flush_wheel()

        if kind == "mousedown":
            button_index = e.get("button")
            if isinstance(button_index, bool) or not isinstance(button_index, int) or button_index not in (0, 1, 2):
                return
            btn = ["left", "middle", "right"][button_index]
            if btn not in pressed_buttons:
                pydirectinput.mouseDown(button=btn)
                pressed_buttons.add(btn)

        elif kind == "mouseup":
            button_index = e.get("button")
            if isinstance(button_index, bool) or not isinstance(button_index, int) or button_index not in (0, 1, 2):
                return
            btn = ["left", "middle", "right"][button_index]
            pydirectinput.mouseUp(button=btn)
            pressed_buttons.discard(btn)

        elif kind in ("keydown", "keyup"):
            code = e.get("code") or ""
            key = e.get("key") or ""
            if not isinstance(code, str) or len(code) > 32 or not isinstance(key, str) or len(key) > 32:
                return

            if is_synthetic_symbol(e):
                return

            ktype, value = resolve_key(code, key)

            if ktype == "modifier":
                if kind == "keydown":
                    press_mod(code)
                else:
                    release_mod(code)
                return

            if ktype == "ignore":
                return

            if ktype in ("direct", "special", "char"):
                if kind == "keydown":
                    if value not in pressed_keys:
                        pydirectinput.keyDown(value)
                        pressed_keys.add(value)
                else:
                    pydirectinput.keyUp(value)
                    pressed_keys.discard(value)
                return

    except Exception as ex:
        report_error(ex)


def main():
    print("[*] c4 input bridge running...", flush=True)

    for line in sys.stdin:
        try:
            msg = json.loads(line.strip())
            if "kind" in msg:
                handle(msg)
        except Exception as e:
            report_error(e)


if __name__ == "__main__":
    main()
