# Voice Keys

[Русская версия](README.md)

A voice controller for Windows: say a word and the program presses a key (or holds it, or toggles it). Made for games where your hands are busy: Dota 2, Deadlock, iRacing and others. Everything runs locally; your voice is never sent anywhere.

- **Three actions:** tap, hold for a set time, or toggle (the key stays down until you say the command again).
- **Profiles** per game. A fresh install has a single "General" profile that cannot be deleted (it holds the Deadlock commands); you add the others. A profile holds its commands and the words of its neural network; model, language and microphone are shared.
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
