'use strict';
function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}
function microphoneCheck({ owner, permission, requestingOrigin, details = {}, origin }) {
  return Boolean(owner && permission === 'media' && details.mediaType !== 'video' &&
    sameOrigin(requestingOrigin || details.securityOrigin || details.requestingUrl, origin));
}
module.exports = { sameOrigin, microphoneCheck };
