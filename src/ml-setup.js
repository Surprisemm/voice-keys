'use strict';
// Python + PyTorch environment for training the personal classifier (data/ml/venv). Used by the app and by `npm run setup-ml`.
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TORCH_VERSION = '2.14.1', PYTHON_VERSION = '3.12';
const INDEX = { cuda: 'https://download.pytorch.org/whl/cu130', cpu: 'https://download.pytorch.org/whl/cpu' };

const venvPython = mlDir => path.join(mlDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const installed = mlDir => fs.existsSync(venvPython(mlDir));

function findUv() {
  const names = process.platform === 'win32' ? ['uv.exe'] : ['uv'], dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')];
  for (const dir of dirs) for (const name of names) { const file = path.join(dir, name); if (dir && fs.existsSync(file)) return file; }
  return null;
}
function findPython() {
  for (const [command, args] of [['py', ['-3.12', '-c', 'import sys;print(sys.executable)']], ['py', ['-3.13', '-c', 'import sys;print(sys.executable)']], ['python', ['-c', 'import sys;print(sys.executable if sys.version_info[:2] in ((3,10),(3,11),(3,12),(3,13)) else "")']]]) {
    try { const out = execFileSync(command, args, { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); if (out && fs.existsSync(out)) return out; } catch { /* try the next */ }
  }
  return null;
}
function hasNvidia() { try { execFileSync('nvidia-smi', ['-L'], { timeout: 8000, windowsHide: true, stdio: 'pipe' }); return true; } catch { return false; } }

// The commands to run, in order. Pure: tests check it without starting anything.
function plan({ mlDir, nvidia, uv, python }) {
  const venv = path.join(mlDir, 'venv'), vpy = venvPython(mlDir), index = nvidia ? INDEX.cuda : INDEX.cpu;
  const torch = [`torch==${TORCH_VERSION}`, 'torchaudio', 'numpy'];
  if (uv) return [
    { label: `Создаю окружение Python ${PYTHON_VERSION}`, command: uv, args: ['venv', '--python', PYTHON_VERSION, venv] },
    { label: `Скачиваю PyTorch (${nvidia ? 'для видеокарты NVIDIA, около 2 ГБ' : 'для процессора, около 200 МБ'})`, command: uv, args: ['pip', 'install', '--python', vpy, ...torch, '--index-url', index, '--extra-index-url', 'https://pypi.org/simple', '--index-strategy', 'unsafe-best-match'] }
  ];
  if (python) return [
    { label: 'Создаю окружение Python', command: python, args: ['-m', 'venv', venv] },
    { label: `Скачиваю PyTorch (${nvidia ? 'для видеокарты NVIDIA, около 2 ГБ' : 'для процессора, около 200 МБ'})`, command: vpy, args: ['-m', 'pip', 'install', ...torch, '--index-url', index, '--extra-index-url', 'https://pypi.org/simple'] }
  ];
  throw new Error('Не найден ни uv, ни Python 3.10–3.13. Установите Python с python.org или uv (https://docs.astral.sh/uv/) и повторите.');
}

function run(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', UV_LINK_MODE: 'copy' } });
    let tail = '';
    const feed = data => { for (const line of String(data).split(/\r?\n|\r/)) { if (line.trim()) { tail = (tail + '\n' + line).slice(-600); onLine(line.trim()); } } };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} завершился с кодом ${code}: ${tail.trim().split('\n').slice(-3).join(' | ')}`)));
  });
}

// What the environment can do: { installed, torch, cuda, gpu } (asks Python once, a second or two).
function probe(mlDir) {
  return new Promise(resolve => {
    if (!installed(mlDir)) { resolve({ installed: false }); return; }
    execFile(venvPython(mlDir), ['-c', 'import json,torch;print(json.dumps({"torch":torch.__version__,"cuda":torch.cuda.is_available(),"gpu":torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""}))'], { timeout: 60000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve({ installed: true, broken: true, error: error.message.slice(0, 200) }); return; }
      try { resolve({ installed: true, ...JSON.parse(stdout.trim().split('\n').pop()) }); } catch { resolve({ installed: true, broken: true }); }
    });
  });
}

async function setup({ mlDir, onLine = () => {}, nvidia = hasNvidia(), uv = findUv(), python = uv ? null : findPython(), runCommand = run }) {
  fs.mkdirSync(mlDir, { recursive: true });
  const steps = plan({ mlDir, nvidia, uv, python });
  for (const step of steps) { onLine(`== ${step.label}`); await runCommand(step.command, step.args, onLine); }
  const result = await probe(mlDir);
  if (!result.torch || result.broken) throw new Error('Окружение создано, но PyTorch не запускается.');
  onLine(`Готово: PyTorch ${result.torch}${result.cuda ? `, видеокарта ${result.gpu}` : ', без видеокарты'}`);
  return result;
}
module.exports = { venvPython, installed, findUv, findPython, hasNvidia, plan, probe, setup, TORCH_VERSION, INDEX };
