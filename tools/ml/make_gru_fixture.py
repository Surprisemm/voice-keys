"""Writes test/fixtures/gru-parity.json: a small random GRU model, an input sequence and PyTorch's class probabilities for it.
The JavaScript runtime (src/classifier/detector.js) must reproduce them. Run: python tools/ml/make_gru_fixture.py"""
import json
import pathlib
import sys

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from model import StreamingGru, export_model  # noqa: E402

torch.manual_seed(5)
model = StreamingGru(mels=32, hidden=12, layers=2, classes=4).eval()
frames = torch.randn(1, 40, 32)
with torch.no_grad():
    probs = torch.softmax(model(frames)[0][0], dim=-1).numpy()
exported = export_model(model, ["a", "b", "c"], np.zeros(32), np.ones(32), 0.9, 2, 90, 150, {}, {})
out = {"model": exported, "frames": frames[0].tolist(), "probs": probs.tolist()}
target = pathlib.Path(__file__).parents[2] / "test" / "fixtures" / "gru-parity.json"
target.write_text(json.dumps(out), encoding="utf-8")
print(target, round(target.stat().st_size / 1024), "KB")
