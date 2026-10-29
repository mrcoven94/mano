# Run: pip install "modal==1.6.2" && python -m unittest discover -s packages/guardian/modal
import json
import sys
import threading
import time
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))
import app  # noqa: E402

PASS = '{"verdict":"pass","problems":[]}'
BLOCK = '{"verdict":"block","problems":["The recipient is not the one the person approved."]}'


class CollectAllEngine:
    """Copies vLLM's offline LLM: every caller steps one shared engine and
    returns every request that finished during its call, sorted by id."""

    def __init__(self):
        self._lock = threading.Lock()
        self._next_id = 0
        self._pending = []

    def chat(self, messages, sampling_params, use_tqdm):
        unsafe = "[OTHER-1]" in messages[-1]["content"]
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            self._pending.append((request_id, BLOCK if unsafe else PASS))
        # The unsafe check is shorter, so it steps the engine first.
        time.sleep(0.05 if unsafe else 0.2)
        with self._lock:
            finished, self._pending = self._pending, []
        return [
            SimpleNamespace(
                request_id=str(rid),
                outputs=[SimpleNamespace(text=text, finish_reason="stop")],
            )
            for rid, text in sorted(finished)
        ]


def check_body(recipient):
    return {
        "action": {
            "type": "send",
            "recipient": recipient,
            "purpose": "SNAP renewal",
            "payload": {"claims": ["Dana Whitfield renewed her SNAP case."]},
        },
        "sources": [],
        "consents": [{"recipient": "[RECIPIENT]", "purpose": "SNAP renewal"}],
        "origin": "person",
    }


class OverlappingChecks(unittest.TestCase):
    def test_each_check_gets_its_own_verdict(self):
        engine = CollectAllEngine()
        engine_lock = threading.Lock()
        results = {}

        def run(name, recipient, delay):
            time.sleep(delay)
            try:
                results[name] = app.ask_model(engine, engine_lock, check_body(recipient), None)["verdict"]
            except RuntimeError as error:
                results[name] = f"error: {error}"

        threads = [
            threading.Thread(target=run, args=("safe", "[RECIPIENT]", 0.0)),
            threading.Thread(target=run, args=("unsafe", "[OTHER-1]", 0.02)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results, {"safe": "pass", "unsafe": "block"})


class FakeTime:
    """A clock that moves only when the hold sleeps, firing scheduled
    warm-ups as it passes them."""

    def __init__(self, hold_ref, warm_ups):
        self.now = 0.0
        self.hold_ref = hold_ref
        self.warm_ups = sorted(warm_ups)
        self.extra_holders = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        while self.warm_ups and self.warm_ups[0] <= self.now:
            self.warm_ups.pop(0)
            owed = self.hold_ref[0].hold(app.WARM_HOLD_SECONDS, app.WARM_ROTATE_SECONDS)
            self.extra_holders.append(owed)


def minutes(value):
    return value * 60.0


class WarmUps(unittest.TestCase):
    def make(self, warm_ups):
        ref = []
        fake = FakeTime(ref, warm_ups)
        ref.append(app.WarmHold(clock=fake.clock, sleep=fake.sleep))
        return ref[0], fake

    def test_the_hold_beats_while_it_holds(self):
        ref = []
        fake = FakeTime(ref, [])
        beats = []
        ref.append(app.WarmHold(clock=fake.clock, sleep=fake.sleep, beat=lambda: beats.append(fake.now)))
        ref[0].hold(30, app.WARM_ROTATE_SECONDS)
        self.assertEqual(beats[0], 0)
        self.assertTrue(all(b - a <= 5 for a, b in zip(beats, beats[1:])))
        self.assertLess(fake.now - beats[-1], app.READY_WITHIN_SECONDS)

    def test_ready_only_while_the_heartbeat_is_fresh(self):
        self.assertFalse(app.is_ready(None, 100.0))
        self.assertTrue(app.is_ready(95.0, 100.0))
        self.assertFalse(app.is_ready(100.0 - app.READY_WITHIN_SECONDS, 100.0))

    def test_a_warm_up_during_a_hold_only_moves_the_deadline(self):
        hold, fake = self.make([minutes(4)])
        self.assertEqual(hold.hold(app.WARM_HOLD_SECONDS, app.WARM_ROTATE_SECONDS), 0)
        self.assertEqual(fake.extra_holders, [0])
        self.assertEqual(fake.now, minutes(14))

    def test_a_hold_past_the_execution_limit_rotates_and_keeps_its_promise(self):
        hold, fake = self.make([minutes(9), minutes(18), minutes(27)])
        owed = hold.hold(app.WARM_HOLD_SECONDS, app.WARM_ROTATE_SECONDS)
        first_call_ended = fake.now
        self.assertLess(first_call_ended, app.GPU_TIMEOUT_SECONDS)
        self.assertGreater(owed, 0)
        # Guardian.warm hands the rest to a fresh call: warm(0).
        self.assertEqual(hold.hold(0, app.WARM_ROTATE_SECONDS), 0)
        self.assertLess(fake.now - first_call_ended, app.GPU_TIMEOUT_SECONDS)
        self.assertEqual(fake.now, minutes(37))


class Verdicts(unittest.TestCase):
    def test_the_review_never_leaves_the_server(self):
        text = '{"review":"The payload sends to [EMAIL-1].","verdict":"block","problems":["Wrong address."]}'
        self.assertEqual(
            app.parse_verdict(text), {"verdict": "block", "problems": ["Wrong address."]}
        )


class MinContainers(unittest.TestCase):
    def test_defaults_to_scale_to_zero(self):
        self.assertEqual(app.min_containers_from_env(None), 0)
        self.assertEqual(app.min_containers_from_env(""), 0)
        self.assertEqual(app.min_containers_from_env("1"), 1)

    def test_refuses_other_values(self):
        for bad in ("2", "-1", "yes"):
            with self.assertRaises(RuntimeError):
                app.min_containers_from_env(bad)


if __name__ == "__main__":
    unittest.main()
