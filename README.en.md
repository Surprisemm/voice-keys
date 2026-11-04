# Voice Keys

[Русская версия](README.md)

A voice controller for Windows: say a word and the program presses a key (or holds it, or toggles it). Everything runs locally; your voice is never sent anywhere.

## About

This is a personal project: I built it for myself, as a person with a disability, to interact with my computer more comfortably and to press keys in games without using my hands. The app was "vibe-coded" with Claude and ChatGPT: I set the tasks and checked the results, the models wrote the code. It is not only for games: it is just as useful for everyday work at the computer, since any word can be bound to any key or key combination, mouse button or wheel.

The project is shared as is, without warranty. Suggestions and bug reports are welcome in [Issues](https://github.com/Surprisemm/voice-keys/issues).

## Fair play

The app is deliberately simple: **one command, one action**. A word presses one key, or a key with the Ctrl, Alt or Shift modifiers, holds it, or toggles it. There are no macros, key sequences, repeats or scripts, and I left them out on purpose so that the app gives no unfair advantage in games.

Also, whichever recognition is used, a speech-to-text model or the trained neural network, the app has a delay: the word has to be spoken and recognised. In our measurements the network reacts about 0.1 s after the start of the word, the speech-to-text models usually after 0.3-0.5 s, and a pause is kept between key presses (80 ms by default). So the app cannot press keys faster than a healthy person could by hand: it is a way to press keys by voice, not a way to speed up play.

- **Three actions:** tap, hold for a set time, or toggle (the key stays down until you say the command again).
- **Profiles** per game. A fresh install has a single "General" profile that cannot be deleted (it holds a few example commands); you add the others. A profile holds its commands and the words of its neural network; model, language and microphone are shared.
- **Three speech models**, downloaded inside the app: GigaAM v3 (Russian, the most accurate), Vosk Small (Russian and English), T-one (Russian).
- **Personal voice classifier:** a small neural network trained on your own recordings. It recognises a command from its first syllable, before the speech model does. Train one network per profile or one shared network. Whoever recognises a command first presses it, once.
- On-screen overlay with the key queue, low-latency WASAPI capture, tray icon, start with Windows.

## Install

1. Download `Voice-Keys-Setup-<version>.exe` from the releases and run it. It installs for all users into `C:\Program Files\Voice Keys` (Windows asks for administrator permission); the wizard lets you choose desktop and Start menu shortcuts. A single-file `Voice-Keys-<version>-portable.exe` is also built.
2. On first start download a speech model: next to the model selector the app shows its licence, source and size, and a **Download** button. Internet is needed once.
3. Pick a microphone, press the start button and speak. "Preview only" is a safe mode without key presses; "Press keys" sends real input.

The build is unsigned, so SmartScreen may warn about an unknown publisher.

## Run from source

Windows 10/11 x64 and Node.js 22+ are required.

```bash
start.bat        # installs dependencies and starts the app
npm ci && npm start
npm run setup    # download the Vosk models into models/ (development)
npm test
npm run pack     # build the installer and the portable exe into release/
```

Training the classifier needs Python and PyTorch (about 2 GB with an NVIDIA GPU, once); the app installs them with one button, or run `npm run setup-ml`.

## Licences

Program code: [MIT](LICENSE). The speech models are **not** part of the repository or the installer: each one is downloaded from its author and its licence is shown in the app first (GigaAM v3: MIT; Vosk Small and T-one: Apache 2.0). More detail in the Russian [README](README.md#лицензии) and in [docs/](docs/GUIDE.md).
