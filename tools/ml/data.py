"""Recordings, held-out split and on-the-fly augmentation for training the personal command classifier.

Every training step builds fresh synthetic "streams" from the user's clips: one to three words in a row with random gaps, random speed,
volume, tone tilt, room echo, hard clipping, a noise floor and a background snippet mixed in. Frame labels follow the same rule as the
JavaScript trainer: the command class once `tau` ms of the word are heard (up to `tail` ms after it ends), nothing decided inside the
first `tau` ms of a word, "no command" everywhere else.
"""
import math
import pathlib
import random

import numpy as np
import torch
import torch.nn.functional as F

import features
from features import RATE, FRAME, HOP

IGNORE = -100


def load_dataset(directory, only=None):
    """directory/words/<word>/*.wav and directory/background/*.wav -> clips, skipped names, background arrays (16 kHz).
    `only`: names of the words to load (the rest of the library is ignored)."""
    directory = pathlib.Path(directory)
    clips, skipped, background = [], [], []
    words_dir = directory / "words"
    if words_dir.exists():
        for folder in sorted(p for p in words_dir.iterdir() if p.is_dir() and (only is None or p.name in only)):
            for path in sorted(folder.glob("*.wav")):
                data, rate = features.read_wav(path)
                samples = features.js_resample(data, rate)
                span = features.segment_word(samples)
                if span is None or not (RATE * 0.12 <= span[1] - span[0] <= RATE * 1.6):
                    skipped.append(f"{folder.name}/{path.name}")
                    continue
                clips.append({"word": folder.name, "wav": samples, "start": span[0], "end": span[1], "file": f"{folder.name}/{path.name}"})
    bg_dir = directory / "background"
    if bg_dir.exists():
        for path in sorted(bg_dir.glob("*.wav")):
            data, rate = features.read_wav(path)
            background.append(features.js_resample(data, rate))
    return clips, skipped, background


def split_clips(clips, words, holdout=0.15, seed=11):
    train, held = [], []
    for word in words:
        items = [c for c in clips if c["word"] == word]
        count = max(1, round(len(items) * holdout)) if len(items) >= 6 else 0
        order = list(range(len(items)))
        random.Random(seed + len(word)).shuffle(order)
        for rank, i in enumerate(order):
            (held if rank < count else train).append(items[i])
    return train, held


def split_background(background, seed=11, chunk=RATE * 6):
    train, held = [], []
    for i, audio in enumerate(background):
        for at in range(0, len(audio), chunk):
            part = audio[at: at + chunk]
            if len(part) < RATE:
                continue
            (held if (at // chunk + i) % 7 == 0 else train).append(part)
    return train, held


def _rms(x):
    return float(torch.sqrt((x.double() ** 2).mean()).item()) if x.numel() else 0.0


class Augmenter:
    def __init__(self, clips, words, background, device, tau_ms=90, tail_ms=150, seed=1, stream_seconds=4.0):
        self.device, self.words = device, list(words)
        self.tau, self.tail = tau_ms * RATE // 1000, tail_ms * RATE // 1000
        self.length = int(stream_seconds * RATE)
        self.rng = random.Random(seed)
        self.torch_gen = torch.Generator(device=device).manual_seed(seed)
        self.by_class = {i + 1: [] for i in range(len(self.words))}
        for c in clips:
            self.by_class[self.words.index(c["word"]) + 1].append({"wav": torch.tensor(c["wav"], device=device), "start": c["start"], "end": c["end"]})
        self.background = [torch.tensor(b, device=device) for b in background]
        self.frames = (self.length - FRAME) // HOP + 1

    # ----- helpers -----
    def _noise(self, n, sigma):
        white = torch.randn(n, device=self.device, generator=self.torch_gen)
        alpha = self.rng.uniform(0.0, 0.92)
        if alpha > 0.05:  # one-pole low-pass: coloured noise
            idx = torch.arange(n, device=self.device)
            kernel_len = min(n, 256)
            kernel = (alpha ** torch.arange(kernel_len, device=self.device, dtype=torch.float32)) * (1 - alpha)
            white = torch.fft.irfft(torch.fft.rfft(white, n=n + kernel_len) * torch.fft.rfft(kernel, n=n + kernel_len), n=n + kernel_len)[:n]
            white = white / (white.std() + 1e-9)
        return white * sigma

    def _snippet(self, n):
        if not self.background:
            return torch.zeros(n, device=self.device)
        source = self.background[self.rng.randrange(len(self.background))]
        at = self.rng.randrange(max(1, len(source)))
        if len(source) - at >= n:
            return source[at: at + n]
        reps = torch.cat([source[at:], source.repeat((n // max(1, len(source))) + 2)])
        return reps[:n]

    def _reverb(self, x):
        n = int(RATE * self.rng.uniform(0.05, 0.3))
        decay = torch.exp(-torch.arange(n, device=self.device, dtype=torch.float32) / (RATE * self.rng.uniform(0.03, 0.12)))
        rir = torch.randn(n, device=self.device, generator=self.torch_gen) * decay
        rir[0] = 1.0
        rir = rir / rir.norm()
        size = len(x) + n
        y = torch.fft.irfft(torch.fft.rfft(x, n=size) * torch.fft.rfft(rir, n=size), n=size)[: len(x)]
        return y * (_rms(x) / max(_rms(y), 1e-9))

    def _word(self, cls, mild, item=None):
        item = item or self.rng.choice(self.by_class[cls])
        speed = self.rng.uniform(0.97, 1.03) if mild else self.rng.uniform(0.86, 1.14)
        wav, start, end = item["wav"], item["start"], item["end"]
        if abs(speed - 1) > 0.004:
            wav = F.interpolate(wav[None, None], scale_factor=1 / speed, mode="linear", align_corners=False)[0, 0]
            start, end = int(start / speed), int(end / speed)
        if not mild:
            alpha = self.rng.uniform(-0.3, 0.7)  # tone tilt, as a different microphone would give
            if abs(alpha) > 0.05:
                before = _rms(wav[start:end])
                wav = torch.cat([wav[:1], wav[1:] - alpha * wav[:-1]])
                wav = wav * (before / max(_rms(wav[start:end]), 1e-9))
        return wav, start, end

    # ----- one stream -----
    def stream(self, mild=False, words_in_stream=None, background_only=False, total=None, fixed=None):
        """fixed=(class, item) puts exactly that clip in the stream (used for held-out evaluation)."""
        n = total or self.length
        canvas = torch.zeros(n, device=self.device)
        placements = []  # (start, end, class)
        if not background_only:
            count = words_in_stream or self.rng.choices([1, 2, 3], weights=[5, 3, 1])[0]
            cursor = int(RATE * 0.8) if mild else int(RATE * self.rng.uniform(0.25, 0.9))
            for _ in range(count):
                cls, item = fixed if fixed else (self.rng.randrange(1, len(self.words) + 1), None)
                wav, start, end = self._word(cls, mild, item)
                gain = 10 ** ((self.rng.uniform(-4, 4) if mild else self.rng.uniform(-14, 8)) / 20)
                if cursor + (end - start) > n - int(RATE * 0.25):
                    break
                lo = cursor - start  # canvas index of wav[0]
                src, dst = max(0, -lo), max(0, lo)
                length = min(len(wav) - src, n - dst)
                canvas[dst: dst + length] += wav[src: src + length] * gain
                placements.append((cursor, cursor + end - start, cls))
                cursor += end - start + int(RATE * self.rng.uniform(0.06, 0.7))
        speech = max(_rms(canvas[placements[0][0]: placements[-1][1]]) if placements else 0.0, 1e-4)
        level = speech if placements else 10 ** self.rng.uniform(-3.2, -1.4)
        if placements and not mild and self.rng.random() < 0.25:
            canvas = self._reverb(canvas)
        canvas = canvas + self._noise(n, 10 ** (-3.6 if mild else self.rng.uniform(-4.2, -2.4)))
        if self.background and self.rng.random() < (0.4 if mild else 0.7):
            mix = self._snippet(n)
            snr = self.rng.uniform(12, 24) if mild else self.rng.uniform(2, 25)
            canvas = canvas + mix * (level * 10 ** (-snr / 20) / max(_rms(mix), 1e-5))
        if not mild and self.rng.random() < 0.08:  # a loud microphone clips
            canvas = torch.clamp(canvas * self.rng.uniform(1.5, 4.0), -1, 1)
        return canvas, placements

    def labels(self, placements, frames):
        out = np.zeros(frames, dtype=np.int64)
        ends = np.arange(frames) * HOP + FRAME
        ignored = np.zeros(frames, dtype=bool)
        for start, end, cls in placements:
            positive = (ends >= start + self.tau) & (ends <= end + self.tail)
            out[positive & ~ignored] = cls
            zone = (ends >= start) & (ends < start + self.tau)
            out[zone] = IGNORE
            ignored |= zone
        return out

    def batch(self, size, background_share=0.2):
        waves, labels = [], []
        for _ in range(size):
            only_bg = self.rng.random() < background_share
            wave, placements = self.stream(mild=False, background_only=only_bg)
            waves.append(wave)
            labels.append(self.labels(placements, self.frames))
        return torch.stack(waves), torch.tensor(np.stack(labels), device=self.device)

    def eval_audio(self, clip, variant):
        """A held-out clip with 0.8 s of lead and trail; variant 0 is clean, others get mild augmentation. -> (audio, start, end)."""
        wav = torch.tensor(clip["wav"], device=self.device)
        lead = int(RATE * 0.8)
        n = lead * 2 + len(wav)
        if variant == 0:
            canvas = torch.zeros(n, device=self.device)
            canvas[lead: lead + len(wav)] = wav
            return canvas + self._noise(n, 6e-4), lead + clip["start"], lead + clip["end"]
        cls = self.words.index(clip["word"]) + 1
        canvas, placements = self.stream(mild=True, words_in_stream=1, total=n + int(RATE * 0.4), fixed=(cls, {"wav": wav, "start": clip["start"], "end": clip["end"]}))
        return canvas, placements[0][0], placements[0][1]
