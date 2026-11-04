"""Checks that tools/ml/features.py gives the same numbers as src/classifier/dsp.js (fixture from scripts/make-classifier-fixture.js)."""
import json
import pathlib
import sys

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import features  # noqa: E402

FIXTURE = pathlib.Path(__file__).parents[2] / "test" / "fixtures" / "classifier-parity.json"


def test_signal(rate, seconds):
    n = round(rate * seconds)
    state, out = 12345, np.zeros(n, dtype=np.float64)
    t = np.arange(n) / rate
    noise = np.zeros(n)
    for i in range(n):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        noise[i] = state / 4294967296 - 0.5
    out = 0.3 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 2300 * t + 1) + 0.15 * np.sin(2 * np.pi * (300 + 2000 * t) * t) + 0.05 * noise
    return out.astype(np.float32)


def main():
    fixture = json.loads(FIXTURE.read_text())
    failures = 0
    for rate in (44100, 48000):
        expected = np.array(fixture[str(rate)]["resampled"], dtype=np.float32)
        got = features.js_resample(test_signal(rate, 0.6), rate)
        same_length = len(got) == len(expected)
        diff = float(np.abs(got[: len(expected)] - expected[: len(got)]).max())
        ok = same_length and diff < 2e-5
        print(f"resample {rate}: length {len(got)} vs {len(expected)}, max difference {diff:.2e} -> {'ok' if ok else 'FAIL'}")
        failures += 0 if ok else 1
    expected = np.array(fixture["logMel48000"], dtype=np.float32)
    got = features.log_mel(torch.tensor(np.array(fixture["48000"]["resampled"], dtype=np.float32))).numpy()
    same_shape = got.shape == expected.shape
    diff = float(np.abs(got - expected).max()) if same_shape else float("inf")
    ok = same_shape and diff < 2e-3
    print(f"log-mel: shape {got.shape} vs {expected.shape}, max difference {diff:.2e} -> {'ok' if ok else 'FAIL'}")
    failures += 0 if ok else 1
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
