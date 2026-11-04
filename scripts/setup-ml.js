'use strict';
// Installs Python 3.12 + PyTorch into data/ml/venv for training the personal command classifier (about 2 GB with a NVIDIA card).
//   npm run setup-ml
const path = require('node:path');
const { setup } = require('../src/ml-setup');
const mlDir = process.env.VOICE_KEYS_ML_DIR || path.join(process.env.VOICE_KEYS_DATA_DIR || path.join(__dirname, '..', 'data'), 'ml');
setup({ mlDir, onLine: line => console.log(line) }).then(info => { console.log(JSON.stringify(info)); }).catch(error => { console.error(error.message); process.exit(1); });
