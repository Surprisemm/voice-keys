"""Signal chain of the personal command classifier, identical to src/classifier/dsp.js.

Training must see exactly what the app computes at run time: the same low-pass + linear-interpolation resampler to 16 kHz and the
same log-mel frames (400-sample Hann frames with pre-emphasis inside the frame, hop 160, 512-point FFT, 32 mel bands). The parity
test (tools/ml/test_parity.py) compares this code with the JavaScript output.
"""
import math
import wave

import numpy as np
import torch

RATE, FRAME, HOP, NFFT, MELS, FMIN, FMAX = 16000, 400, 160, 512, 32, 60.0, 7600.0


def read_wav(path):
    """Mono float32 samples in [-1, 1] and the sample rate of a 16-bit WAV file."""
    with wave.open(str(path), "rb") as f:
        channels, width, rate, frames = f.getnchannels(), f.getsampwidth(), f.getframerate(), f.getnframes()
        raw = f.readframes(frames)
    if width != 2:
        raise ValueError(f"{path}: need 16-bit WAV")
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def _fir_taps(source_rate, target_rate=RATE, taps=63):
    cutoff = min(0.46 * target_rate, 0.46 * source_rate) / source_rate
    n = np.arange(taps) - (taps - 1) / 2
    with np.errstate(divide="ignore", invalid="ignore"):
        sinc = np.where(n == 0, 2 * cutoff, np.sin(2 * np.pi * cutoff * n) / (np.pi * n))
    window = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(taps) / (taps - 1))
    h = sinc * window
    return (h / h.sum()).astype(np.float64)


def js_resample(samples, source_rate, target_rate=RATE):
    """Same as Resampler in dsp.js for one whole recording: causal FIR low-pass, then linear interpolation."""
    x = np.asarray(samples, dtype=np.float32)
    if source_rate == target_rate:
        return x
    taps = _fir_taps(source_rate, target_rate)
    padded = np.concatenate([np.zeros(len(taps) - 1, dtype=np.float32), x])
    filtered = np.convolve(padded, taps[::-1], mode="valid").astype(np.float32)  # filtered[i] = sum_k taps[k] * padded[i + k]
    n, step = len(filtered), source_rate / target_rate
    count = max(0, int(math.floor((n - 2) / step)) + 1) if n >= 2 else 0
    position = np.arange(count, dtype=np.float64) * step
    i0 = np.floor(position).astype(np.int64)
    fraction = (position - i0).astype(np.float32)
    out = filtered[i0] * (1 - fraction) + filtered[np.minimum(i0 + 1, n - 1)] * fraction
    return out.astype(np.float32)


def _mel_bank():
    bins = NFFT // 2 + 1
    hz_to_mel = lambda hz: 2595 * math.log10(1 + hz / 700)
    mel_to_hz = lambda mel: 700 * (10 ** (mel / 2595) - 1)
    points = [mel_to_hz(hz_to_mel(FMIN) + (hz_to_mel(FMAX) - hz_to_mel(FMIN)) * i / (MELS + 1)) for i in range(MELS + 2)]
    bank = np.zeros((MELS, bins), dtype=np.float64)
    for m in range(MELS):
        lo, mid, hi = points[m], points[m + 1], points[m + 2]
        for b in range(bins):
            hz = b * RATE / NFFT
            if lo < hz < mid:
                bank[m, b] = (hz - lo) / (mid - lo)
            elif mid <= hz < hi:
                bank[m, b] = (hi - hz) / (hi - mid)
    return bank


_WINDOW = torch.tensor(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FRAME) / (FRAME - 1)), dtype=torch.float32)
_BANK = torch.tensor(_mel_bank(), dtype=torch.float32)


def log_mel(x):
    """x: tensor [..., samples] at 16 kHz -> [..., frames, MELS]. Frame f covers samples [f*HOP, f*HOP + FRAME)."""
    window, bank = _WINDOW.to(x.device), _BANK.to(x.device)
    if x.shape[-1] < FRAME:
        return x.new_zeros(*x.shape[:-1], 0, MELS)
    frames = x.unfold(-1, FRAME, HOP)
    emphasized = torch.cat([frames[..., :1], frames[..., 1:] - 0.97 * frames[..., :-1]], dim=-1)
    spectrum = torch.fft.rfft(emphasized * window, n=NFFT, dim=-1)
    power = spectrum.real ** 2 + spectrum.imag ** 2
    return torch.log(power @ bank.T + 1e-6)


def segment_word(samples, rate=RATE):
    """Spoken part of a short recording by its energy: (start, end) in samples or None. Same rules as segmentWord in dsp.js."""
    hop = round(rate * 0.01)
    count = len(samples) // hop
    if count < 10:
        return None
    rms = np.sqrt((samples[: count * hop].reshape(count, hop).astype(np.float64) ** 2).mean(axis=1))
    ordered = np.sort(rms)
    floor, peak = ordered[int(len(ordered) * 0.2)], ordered[-1]
    if peak < 0.01 or peak < floor * 4:
        return None
    threshold = max(floor * 3, peak * 0.1)
    loud = np.nonzero(rms > threshold)[0]
    if len(loud) == 0:
        return None
    first, last = int(loud[0]), int(loud[-1])
    return max(0, first - 2) * hop, min(len(samples), (last + 3) * hop)
