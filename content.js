// Runs on every site. Activates only when a poker iframe/table is present.
(function () {
  'use strict';
  if (window !== window.top) return;
  if (window.__pokerAssistantMainInit) return;
  window.__pokerAssistantMainInit = true;

  try { document.documentElement.setAttribute('data-pa-loaded', '3.3.15'); } catch (e) { /* ignore */ }

  var lastInject = 0;
  var lastShotAt = 0;
  var watching = false;

  function findPokerIframe() {
    var nodes = document.querySelectorAll('iframe');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var src = (el.src || el.getAttribute('src') || '').toLowerCase();
      if (el.id === 'pu_poker_iframe') return el;
      if (/e5t\.online|pu-web2|\/poker|poker-game|lucky.?chip/.test(src)) return el;
    }
    return null;
  }

  function hasPoker() {
    return !!(findPokerIframe() || document.querySelector('.PixiComponent, .r-scene-container, .poker-game'));
  }

  function runtimeOk() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function requestInject() {
    if (!hasPoker()) return;
    var now = Date.now();
    if (now - lastInject < 8000) return;
    lastInject = now;
    try {
      if (!runtimeOk()) return;
      chrome.runtime.sendMessage({ action: 'injectIntoIframes' }, function () {
        if (chrome.runtime.lastError) return;
      });
    } catch (e) { /* ignore */ }
  }

  function publishCards(cards) {
    try {
      chrome.runtime.sendMessage({ action: 'publishShot', cards: cards });
    } catch (e) { /* ignore */ }
  }

  function grabTableShot() {
    if (!hasPoker()) return;
    var now = Date.now();
    if (now - lastShotAt < 1800) return;
    lastShotAt = now;
    try {
      if (!runtimeOk()) return;
      chrome.runtime.sendMessage({ action: 'captureTable' }, function (res) {
        if (chrome.runtime.lastError) return;
        if (res && res.cards && res.cards.source === 'py') {
          window.__paShotCards = res.cards;
          publishCards(res.cards);
          return;
        }
        if (!res || !res.dataUrl || !window.PokerVision) return;
        window.PokerVision.readDataUrl(res.dataUrl).then(function (cards) {
          if (window.__paShotCards && window.__paShotCards.source === 'py') return;
          window.__paShotCards = cards;
          publishCards(cards);
        }).catch(function () { /* ignore */ });
      });
    } catch (e) { /* ignore */ }
  }

  function start() {
    if (watching) return;
    watching = true;
    requestInject();
    grabTableShot();
    setInterval(requestInject, 12000);
    setInterval(grabTableShot, 2000);
    try {
      new MutationObserver(function () { requestInject(); }).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
