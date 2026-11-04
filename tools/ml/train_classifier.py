"""Trains the personal command classifier with PyTorch from a folder of the user's recordings.

    python tools/ml/train_classifier.py <dataDir> --out model.json [--steps 3000] [--hidden 96] [--layers 2] [--tau 90] [--jsonl]

dataDir/words/<word>/*.wav   one spoken word per file (any sample rate, 16-bit)
dataDir/background/*.wav     everything that is not a command

With --jsonl every line on stdout is one JSON object ({"type": "log" | "progress" | "done" | "error", ...}) for the app to read.
"""
import argparse
import json
import os
import math
import pathlib
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import features  # noqa: E402
from data import Augmenter, IGNORE, load_dataset, split_background, split_clips  # noqa: E402
from model import Firer, StreamingGru, export_model  # noqa: E402

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98]


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * p))]


class Reporter:
    def __init__(self, jsonl):
        self.jsonl = jsonl

    def emit(self, kind, message="", **extra):
        if self.jsonl:
            print(json.dumps({"type": kind, "message": message, **extra}, ensure_ascii=False), flush=True)
        elif message:
            print(message, flush=True)


def infer(model, mean, std, audio):
    with torch.no_grad():
        x = (features.log_mel(audio[None]) - mean) / std
        logits, _ = model(x)
        return torch.softmax(logits[0], dim=-1).cpu().numpy()


def fires(probs, classes, threshold, hold):
    firer, out = Firer(classes, threshold, hold), []
    for frame, p in enumerate(probs):
        c = firer.feed(p, frame)
        if c > 0:
            out.append((c, frame, (frame * features.HOP + features.FRAME) / features.RATE * 1000))
    return out


def evaluate(model, mean, std, held, words, aug_val, bg_held, hold):
    runs = []
    for clip in held:
        for variant in range(3):
            audio, start, end = aug_val.eval_audio(clip, variant)
            runs.append((words.index(clip["word"]) + 1, start / features.RATE * 1000, end / features.RATE * 1000, infer(model, mean, std, audio)))
    background = [(len(b) / features.RATE, infer(model, mean, std, torch.tensor(b, device=mean.device))) for b in bg_held]
    classes, rows = len(words) + 1, []
    for threshold in THRESHOLDS:
        found = wrong = spurious = 0
        latency = []
        for cls, start, end, probs in runs:
            events = fires(probs, classes, threshold, hold)
            inside = [e for e in events if start <= e[2] <= end + 400]
            if inside:
                if inside[0][0] == cls:
                    found += 1
                    latency.append(inside[0][2] - start)
                else:
                    wrong += 1
            spurious += len(events) - len(inside) + max(0, len(inside) - 1)
        false_events = sum(len(fires(p, classes, threshold, hold)) for _, p in background)
        n = max(1, len(runs))
        rows.append({"threshold": threshold, "clips": len(runs), "detected": found / n, "wrong": wrong / n, "spuriousPerClip": spurious / n,
                     "backgroundFalse": false_events, "backgroundSeconds": sum(s for s, _ in background),
                     "latencyMedianMs": percentile(latency, 0.5), "latencyP90Ms": percentile(latency, 0.9)})
    return rows


def pick_threshold(rows):
    clean = [r for r in rows if r["backgroundFalse"] == 0 and r["wrong"] <= 0.02 and r["spuriousPerClip"] <= 0.05]
    pool = clean or rows
    score = lambda r: r["detected"] - 0.3 * r["wrong"] - 0.5 * r["backgroundFalse"]
    best = pool[0]
    for r in pool[1:]:
        if score(r) > score(best) + 1e-9 or (abs(r["detected"] - best["detected"]) < 1e-9 and (r["latencyMedianMs"] or 1e9) < (best["latencyMedianMs"] or 1e9)):
            best = r
    return best["threshold"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("--out", required=True)
    parser.add_argument("--steps", type=int, default=3000)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--hidden", type=int, default=96)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--tau", type=int, default=90)
    parser.add_argument("--tail", type=int, default=150)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--command-weight", type=float, default=2.0)
    parser.add_argument("--hold", type=int, default=2)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--jsonl", action="store_true")
    parser.add_argument("--words", default="", help="comma-separated words to train on; default: every word in the library")
    args = parser.parse_args()
    report = Reporter(args.jsonl)
    started = time.time()
    try:
        device = torch.device("cuda" if args.device == "auto" and torch.cuda.is_available() else ("cpu" if args.device == "auto" else args.device))
        torch.manual_seed(args.seed)
        only = {w for w in args.words.split(",") if w} or None
        clips, skipped, background = load_dataset(args.data, only)
        words = sorted({c["word"] for c in clips})
        if not words:
            raise RuntimeError("Нет записей команд.")
        report.emit("log", f"Записей команд: {len(clips)}, слов: {len(words)}, фоновых файлов: {len(background)}" + (f", пропущено без речи: {', '.join(skipped)}" if skipped else "") + f", устройство: {device}")
        train_clips, held = split_clips(clips, words, seed=args.seed)
        bg_train, bg_held = split_background(background, seed=args.seed)
        report.emit("log", f"Для обучения {len(train_clips)} записей, для проверки {len(held)}; фон {sum(len(b) for b in bg_train) // features.RATE} с (проверка {sum(len(b) for b in bg_held) // features.RATE} с)")
        aug = Augmenter(train_clips, words, bg_train, device, args.tau, args.tail, args.seed)
        optimistic = not held
        aug_val = Augmenter(held or train_clips, words, bg_held or bg_train, device, args.tau, args.tail, args.seed + 1)

        with torch.no_grad():  # feature statistics from augmented streams
            parts = [features.log_mel(aug.batch(16)[0]).reshape(-1, features.MELS) for _ in range(24)]
            frames = torch.cat(parts)
            mean, std = frames.mean(0), frames.std(0).clamp_min(1e-2)
        classes = len(words) + 1
        model = StreamingGru(features.MELS, args.hidden, args.layers, classes).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-2)
        weights = torch.tensor([1.0] + [args.command_weight] * len(words), device=device)
        warmup = max(50, args.steps // 30)
        schedule = lambda s: (s + 1) / warmup if s < warmup else 0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * (s - warmup) / max(1, args.steps - warmup)))
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, schedule)
        report.emit("log", f"Параметров в сети: {sum(p.numel() for p in model.parameters())}")

        running = 0.0
        for step in range(1, args.steps + 1):
            waves, labels = aug.batch(args.batch)
            x = (features.log_mel(waves) - mean) / std
            logits, _ = model(x)
            loss = F.cross_entropy(logits.reshape(-1, classes), labels.reshape(-1), weight=weights, ignore_index=IGNORE, label_smoothing=0.02)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            running += loss.item()
            if step % 50 == 0 or step == args.steps:
                report.emit("progress", f"Шаг {step} из {args.steps}, ошибка {running / (50 if step % 50 == 0 else step % 50):.3f}", step=step, steps=args.steps, loss=running / 50)
                running = 0.0
        model.eval()
        report.emit("log", "Проверяю на записях, которых сеть не видела" if not optimistic else "Записей мало для отдельной проверки: проверяю на тех же записях с лёгким искажением (оценка завышена)")
        rows = evaluate(model, mean, std, held or train_clips, words, aug_val, bg_held, args.hold)
        threshold = pick_threshold(rows)
        trained_on = {"clips": len(train_clips), "held": len(held), "backgroundSeconds": sum(len(b) for b in bg_train) // features.RATE, "optimisticCheck": optimistic, "steps": args.steps, "device": str(device)}
        exported = export_model(model, words, mean.cpu().numpy(), std.cpu().numpy(), threshold, args.hold, args.tau, args.tail, trained_on,
                                {"rows": rows, "classes": words, "arch": f"gru {args.hidden}x{args.layers}"})
        exported["createdAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        pathlib.Path(args.out).write_text(json.dumps(exported), encoding="utf-8")
        report.emit("done", f"Готово за {round(time.time() - started)} с. Порог {threshold}", out=args.out, threshold=threshold, rows=rows, seconds=round(time.time() - started))
        if not args.jsonl:
            print(f"{'порог':>6} {'найдено':>8} {'не то':>6} {'лишних':>7} {'ложных на фоне':>15} {'задержка мс (медиана / p90)':>28}")
            for r in rows:
                print(f"{r['threshold']:>6} {r['detected']:>8.2f} {r['wrong']:>6.2f} {r['spuriousPerClip']:>7.2f} {r['backgroundFalse']:>15} {str(round(r['latencyMedianMs'])) + ' / ' + str(round(r['latencyP90Ms'])) if r['latencyMedianMs'] is not None else '-':>28}")
        sys.stdout.flush()
        os._exit(0)  # skip interpreter/CUDA teardown, which can crash on Windows after everything is saved
    except Exception as error:  # noqa: BLE001 - the app shows the message
        report.emit("error", f"{type(error).__name__}: {error}")
        if not args.jsonl:
            raise
        sys.exit(1)


if __name__ == "__main__":
    main()
