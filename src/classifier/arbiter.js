'use strict';
// Two things can recognise the same spoken command: the fast classifier and the ordinary text recognition. The command must be
// pressed once, by whoever is first. A fire from one source cancels the matching fire from the other that follows within `windowMs`.

const { monotonicNow } = require('../core');

// What a command presses: key, modifiers and the kind of action. Variants of one command ("тяж", "хэви") share it.
const signature = action => `${action.key}|${(action.modifiers || []).join('+')}|${['hold', 'toggle'].includes(action.actionType) ? action.actionType : 'tap'}`;

function createArbiter({ windowMs = 900, now = monotonicNow } = {}) {
  const recent = []; // fires waiting for the other source to confirm: { source, signature, at }
  function claim(source, sig) {
    const t = now();
    while (recent.length && t - recent[0].at > windowMs) recent.shift();
    const match = recent.findIndex(item => item.signature === sig && item.source !== source);
    if (match >= 0) { recent.splice(match, 1); return false; } // the other source already pressed it
    recent.push({ source, signature: sig, at: t });
    return true;
  }
  return { claim, reset: () => { recent.length = 0; }, pending: () => recent.length };
}
module.exports = { createArbiter, signature };
