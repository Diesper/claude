'use strict';
// background/actions/force-send-activation.js
//
// Mantém o fallback histórico de submit e adiciona um ciclo explícito de
// ativação/restauração para attachment. O content script aguarda o ACK da
// ativação antes de repetir o upload, evitando depender só de focus sintético.

(function(scope) {
  function lastErrorMessage() {
    try { return chrome.runtime.lastError?.message || null; } catch (_e) { return null; }
  }

  function callChrome(fn, ...args) {
    return new Promise(resolve => {
      try {
        fn(...args, result => {
          const error = lastErrorMessage();
          resolve({ ok: !error, result: result || null, error });
        });
      } catch (error) {
        resolve({ ok: false, result: null, error: error?.message || String(error) });
      }
    });
  }

  async function readMode(request) {
    if (request.executionMode) return request.executionMode;
    const data = await callChrome(chrome.storage.local.get.bind(chrome.storage.local), ['geminiExecutionMode']);
    return data.result?.geminiExecutionMode || 'temp_chat';
  }

  async function focusMangaContext(mangaTabId) {
    if (!mangaTabId) return false;
    const tabResult = await callChrome(chrome.tabs.get.bind(chrome.tabs), mangaTabId);
    const tab = tabResult.result;
    if (!tab) return false;

    if (tab.windowId) {
      await callChrome(chrome.windows.update.bind(chrome.windows), tab.windowId, { focused: true });
    }
    await callChrome(chrome.tabs.update.bind(chrome.tabs), mangaTabId, { active: true });
    return true;
  }

  async function focusGemini({ geminiTabId, windowId, executionMode }) {
    const mode = executionMode || 'temp_chat';

    if (mode === 'minimized_window' && windowId) {
      const win = await callChrome(
        chrome.windows.update.bind(chrome.windows),
        windowId,
        { state: 'normal', focused: true }
      );
      if (!win.ok) return { ok: false, reason: win.error || 'window_focus_failed' };
      if (geminiTabId) {
        await callChrome(chrome.tabs.update.bind(chrome.tabs), geminiTabId, { active: true });
      }
      return { ok: true, mode };
    }

    if (geminiTabId) {
      const tabResult = await callChrome(chrome.tabs.get.bind(chrome.tabs), geminiTabId);
      const tab = tabResult.result;
      if (tab?.windowId) {
        await callChrome(chrome.windows.update.bind(chrome.windows), tab.windowId, { focused: true });
      }
      const activated = await callChrome(
        chrome.tabs.update.bind(chrome.tabs),
        geminiTabId,
        { active: true }
      );
      if (!activated.ok) {
        return { ok: false, reason: activated.error || 'tab_activation_failed' };
      }
      return { ok: true, mode };
    }

    return { ok: false, reason: 'missing_gemini_tab' };
  }

  async function restoreGemini({ mangaTabId, windowId, executionMode }) {
    const mode = executionMode || 'temp_chat';

    if (mode === 'minimized_window' && windowId) {
      await callChrome(
        chrome.windows.update.bind(chrome.windows),
        windowId,
        { state: 'minimized', focused: false }
      );
    }

    await focusMangaContext(mangaTabId);
    return { ok: true, mode };
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'force-send-activation',
    meta: {
      allowedSources: ['any'],
      async: false,
    },

    execute(request) {
      const { geminiTabId, mangaTabId, windowId, executionMode } = request;

      chrome.storage.local.get(['geminiExecutionMode'], (storage) => {
        const mode = executionMode || storage.geminiExecutionMode || 'temp_chat';

        if (mode === 'minimized_window' && windowId) {
          chrome.windows.update(windowId, { focused: true }, () => {
            chrome.tabs.sendMessage(
              geminiTabId,
              { action: 'DO_SEND_NOW' },
              () => { if (chrome.runtime.lastError) {} }
            );

            setTimeout(() => {
              chrome.windows.update(
                windowId,
                { state: 'minimized', focused: false },
                () => { if (chrome.runtime.lastError) {} }
              );

              if (mangaTabId) {
                chrome.tabs.get(mangaTabId, (mangaTab) => {
                  if (mangaTab && mangaTab.windowId) {
                    chrome.windows.update(
                      mangaTab.windowId,
                      { focused: true },
                      () => { if (chrome.runtime.lastError) {} }
                    );
                  }
                });
              }
            }, 250);
          });
        } else if (geminiTabId) {
          chrome.tabs.update(geminiTabId, { active: true }, () => {
            chrome.tabs.sendMessage(
              geminiTabId,
              { action: 'DO_SEND_NOW' },
              () => { if (chrome.runtime.lastError) {} }
            );

            setTimeout(() => {
              if (mangaTabId) {
                chrome.tabs.update(
                  mangaTabId,
                  { active: true },
                  () => { if (chrome.runtime.lastError) {} }
                );
              }
            }, 250);
          });
        }
      });
    },
  });

  scope.MangaTranslatorRouter.registerAction({
    name: 'force-attachment-activation',
    meta: {
      allowedSources: ['gemini'],
    },
    async execute(request) {
      const executionMode = await readMode(request);
      return focusGemini({
        geminiTabId: request.geminiTabId,
        windowId: request.windowId,
        executionMode,
      });
    },
  });

  scope.MangaTranslatorRouter.registerAction({
    name: 'restore-attachment-activation',
    meta: {
      allowedSources: ['gemini'],
    },
    async execute(request) {
      const executionMode = await readMode(request);
      return restoreGemini({
        mangaTabId: request.mangaTabId,
        windowId: request.windowId,
        executionMode,
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
