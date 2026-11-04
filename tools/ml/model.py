"""Streaming network of the personal command classifier and its export to the file format the app reads."""
import base64

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class StreamingGru(nn.Module):
    """log-mel frame -> Linear+ReLU -> GRU layers -> class logits. Causal: one frame in, one prediction out, state carried along.

    Class 0 is "no command"; classes 1..n are the command words in sorted order.
    """

    def __init__(self, mels=32, hidden=96, layers=2, classes=2, dropout=0.1):
        super().__init__()
        self.mels, self.hidden, self.layers, self.classes = mels, hidden, layers, classes
        self.inp = nn.Linear(mels, hidden)
        self.gru = nn.GRU(hidden, hidden, layers, batch_first=True, dropout=dropout if layers > 1 else 0.0)
        self.out = nn.Linear(hidden, classes)

    def forward(self, x, state=None):
        y, state = self.gru(F.relu(self.inp(x)), state)
        return self.out(y), state


def _b64(tensor):
    return base64.b64encode(tensor.detach().cpu().numpy().astype("<f4").tobytes()).decode("ascii")


def export_model(model, words, mean, std, threshold, hold, tau_ms, tail_ms, trained_on, report):
    """JSON-serialisable dict, format version 2 (arch "gru")."""
    layers = []
    for l in range(model.layers):
        layers.append({
            "wih": _b64(getattr(model.gru, f"weight_ih_l{l}")), "whh": _b64(getattr(model.gru, f"weight_hh_l{l}")),
            "bih": _b64(getattr(model.gru, f"bias_ih_l{l}")), "bhh": _b64(getattr(model.gru, f"bias_hh_l{l}")),
        })
    return {
        "format": "voice-keys-classifier", "version": 2, "arch": "gru",
        "words": list(words), "mels": model.mels, "hidden": model.hidden,
        "mean": [float(v) for v in mean], "std": [float(v) for v in std],
        "net": {"inW": _b64(model.inp.weight), "inB": _b64(model.inp.bias), "gru": layers, "outW": _b64(model.out.weight), "outB": _b64(model.out.bias)},
        "threshold": float(threshold), "hold": int(hold), "tauMs": tau_ms, "tailMs": tail_ms, "trainedOn": trained_on, "report": report,
    }


class Firer:
    """Port of createFirer in src/classifier/detector.js."""

    def __init__(self, classes, threshold=0.9, hold=2, refractory=35, release_probability=0.3, release_frames=5):
        self.classes, self.threshold, self.hold, self.refractory = classes, threshold, hold, refractory
        self.release_probability, self.release_frames = release_probability, release_frames
        self.run = [0] * classes
        self.low = [0] * classes
        self.armed = [True] * classes
        self.last = [-10 ** 9] * classes

    def feed(self, probs, frame):
        best = -1
        for c in range(1, self.classes):
            self.run[c] = self.run[c] + 1 if probs[c] >= self.threshold else 0
            self.low[c] = self.low[c] + 1 if probs[c] < self.release_probability else 0
            if not self.armed[c] and self.low[c] >= self.release_frames and frame - self.last[c] >= self.refractory:
                self.armed[c] = True
            if self.armed[c] and self.run[c] >= self.hold and (best < 0 or probs[c] > probs[best]):
                best = c
        if best > 0:
            self.armed[best] = False
            self.last[best] = frame
        return best
