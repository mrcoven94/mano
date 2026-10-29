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



if __name__ == "__main__":
    unittest.main()
