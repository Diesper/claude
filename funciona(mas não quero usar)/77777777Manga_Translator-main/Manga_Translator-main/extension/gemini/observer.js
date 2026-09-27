'use strict';
// gemini/observer.js — Observer V3 orientado a ownership do model turn.
//
// Resultado automático só pode nascer de uma resposta ESTRITA do modelo.
// Imagens novas no body, no composer ou em user turns nunca recebem ownership
// apenas por serem novas/large/blob.

(function(scope) {
  let selectorsApi = scope.MangaTranslatorGeminiSelectors || null;
  let domApi = scope.MangaTranslatorGeminiDom || null;

  if (typeof require === 'function') {
    if (!selectorsApi) {
      try { selectorsApi = require('./selectors.js'); } catch (_e) {}
    }
    if (!domApi) {
      try { domApi = require('./dom.js'); } catch (_e) {}
    }
  }

  if (!selectorsApi || !selectorsApi.SELECTORS) {
    throw new Error('MangaTranslatorGeminiSelectors indisponível');
  }
  if (!domApi) {
    throw new Error('MangaTranslatorGeminiDom indisponível');
  }

  const { SELECTORS } = selectorsApi;

  function createError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function safeQueryAll(root, selector) {
    if (!root || !selector || typeof root.querySelectorAll !== 'function') return [];
    try { return Array.from(root.querySelectorAll(selector)); } catch (_e) { return []; }
  }

  function deepQueryAll(root, selector) {
    if (!root || !selector) return [];
    if (!domApi.findAllDeep) return safeQueryAll(root, selector);

    return domApi.findAllDeep(root, element => {
      if (!element || element.nodeType !== 1 || typeof element.matches !== 'function') {
        return false;
      }
      try {
        return element.matches(selector);
      } catch (_e) {
        return false;
      }
    });
  }


  function createGeminiObserver({
    jobId,
    root = typeof document !== 'undefined' ? document : null,
    editor = null,
    getEditor = null,
    ignoreImages = new Set(),
    inputImageElements = new Set(),
    onStateChange = null,
    MutationObserverImpl = typeof MutationObserver !== 'undefined' ? MutationObserver : null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    queueMicrotaskFn = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : callback => Promise.resolve().then(callback),
  } = {}) {
    if (!jobId) throw new Error('jobId é obrigatório');
    if (!root) throw new Error('root é obrigatório');
    if (!MutationObserverImpl) throw new Error('MutationObserver indisponível');

    const registryOwner = root.defaultView || root.ownerDocument?.defaultView || scope;
    registryOwner.__mtGeminiObservers = registryOwner.__mtGeminiObservers || {};

    const existing = registryOwner.__mtGeminiObservers[jobId];
    if (existing && typeof existing.stop === 'function') {
      try { existing.stop(); } catch (_e) {}
    }

    const strictResponseSelector = SELECTORS.MODEL_RESPONSE_STRICT || SELECTORS.RESPONSE;
    const initialResponses = new Set(deepQueryAll(root, strictResponseSelector));
    const initialImageSources = new Set();

    deepQueryAll(root, 'img').forEach(img => {
      const src = domApi.getImageSource(img);
      if (src) initialImageSources.add(src);
    });
    for (const src of ignoreImages || []) {
      if (src) initialImageSources.add(src);
    }

    const quarantinedInputElements = new Set(inputImageElements || []);

    const initialErrors = new Set();
    deepQueryAll(root, SELECTORS.ERROR).forEach(element => {
      if (!domApi.isElementVisible(element)) return;
      const text = String(element.innerText || element.textContent || '').trim();
      if (text) initialErrors.add(text);
    });

    const initialEditor = typeof getEditor === 'function' ? getEditor() : editor;
    const initialEditorText = String(initialEditor?.textContent || '').trim();
    const initialSendControls = safeQueryAll(root, SELECTORS.SEND)
      .filter(domApi.isElementVisible);
    const initialSendEnabled = initialSendControls.some(domApi.isControlEnabled);

    const state = {
      jobId,
      initialResponseCount: initialResponses.size,
      initialImageSources,
      responseContainer: null,
      modelTurn: null,
      ready: false,
      submissionConfirmed: false,
      submissionReason: null,
      submissionConfirmedAt: null,
      modelTurnObservedAt: null,
      generationActiveObserved: false,
      generationStarted: false,
      generationFinished: false,
      sendEnabledObserved: initialSendEnabled,
      resultImage: null,
      resultUrl: null,
      resultObservedAt: null,
      error: null,
      done: false,
      cleanedUp: false,
      observer: null,
      responseObserver: null,
      timers: new Set(),
      inspectionScheduled: false,
      inspectCount: 0,
      resultDomObserved: false,
      seenResultSources: new Set(),
      observedMutationRoots: new Set(),
      heartbeatTimer: null,
      fallbackOwnerUsed: false,
    };

    const submissionWaiters = new Set();
    const resultWaiters = new Set();

    function emitState(type, extra = {}) {
      if (typeof onStateChange !== 'function') return;
      try {
        onStateChange(type, {
          jobId,
          ...extra,
          submissionConfirmed: state.submissionConfirmed,
          generationActiveObserved: state.generationActiveObserved,
          responseContainer: state.responseContainer,
          modelTurn: state.modelTurn,
          resultUrl: state.resultUrl,
          error: state.error,
        });
      } catch (_e) {}
    }

    function removeTimer(timer) {
      if (timer === null || timer === undefined) return;
      state.timers.delete(timer);
      try { clearTimeoutFn(timer); } catch (_e) {}
    }

    function settleWaiters(waiters, mode, payload) {
      for (const waiter of Array.from(waiters)) {
        waiters.delete(waiter);
        removeTimer(waiter.timer);
        try {
          if (mode === 'resolve') waiter.resolve(payload);
          else waiter.reject(payload);
        } catch (_e) {}
      }
    }

    function confirmSubmission(reason) {
      if (state.cleanedUp || state.done || state.submissionConfirmed) return false;
      state.submissionConfirmed = true;
      state.submissionReason = reason;
      state.submissionConfirmedAt = Date.now();
      emitState('submission_confirmed', { reason });
      settleWaiters(submissionWaiters, 'resolve', {
        confirmed: true,
        reason,
      });
      return true;
    }

    function markGenerationActive(reason) {
      if (state.cleanedUp || state.done) return false;
      if (!state.generationActiveObserved) {
        state.generationActiveObserved = true;
        state.generationStarted = true;
        emitState('generation_started', { reason });
      }
      confirmSubmission(reason);
      return true;
    }

    function fail(errorText) {
      if (state.cleanedUp || state.done || !errorText) return false;
      state.error = String(errorText || 'Erro desconhecido do Gemini');
      state.done = true;
      const error = createError('GEMINI_UI_ERROR', state.error);
      emitState('ui_error', { error: state.error });
      settleWaiters(submissionWaiters, 'reject', error);
      settleWaiters(resultWaiters, 'reject', error);
      return true;
    }

    function setResult(image, url) {
      if (
        state.cleanedUp ||
        state.done ||
        !url ||
        !state.submissionConfirmed ||
        !state.modelTurn
      ) {
        return false;
      }

      state.resultImage = image || null;
      state.resultUrl = url;
      state.resultObservedAt = Date.now();
      state.done = true;
      emitState('result_image', {
        urlKind: String(url).split(':', 1)[0] || 'unknown',
        elapsedAfterSubmitMs: state.submissionConfirmedAt
          ? state.resultObservedAt - state.submissionConfirmedAt
          : null,
      });
      settleWaiters(resultWaiters, 'resolve', {
        image: state.resultImage,
        url: state.resultUrl,
      });
      return true;
    }

    const mutationObserverOptions = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'src',
        'data-src',
        'disabled',
        'aria-disabled',
        'aria-hidden',
        'style',
        'class',
      ],
    };

    function observeMutationRoot(target) {
      if (!target || !state.observer || state.observedMutationRoots.has(target)) {
        return false;
      }

      try {
        state.observer.observe(target, mutationObserverOptions);
        state.observedMutationRoots.add(target);
        return true;
      } catch (_e) {
        return false;
      }
    }

    function discoverShadowRoots() {
      if (!state.observer) return 0;
      const observeRoot = root.body || root.documentElement || root;
      let discovered = 0;

      const hosts = domApi.findAllDeep
        ? domApi.findAllDeep(observeRoot, element => Boolean(element?.shadowRoot))
        : [];

      for (const host of hosts) {
        try {
          if (host.shadowRoot && observeMutationRoot(host.shadowRoot)) {
            discovered += 1;
          }
        } catch (_e) {}
      }

      return discovered;
    }

    function scheduleHeartbeat() {
      if (state.cleanedUp || state.done || state.heartbeatTimer !== null) return;

      const timer = setTimeoutFn(() => {
        state.timers.delete(timer);
        if (state.heartbeatTimer === timer) state.heartbeatTimer = null;
        if (state.cleanedUp || state.done) return;

        inspect();
        scheduleHeartbeat();
      }, 1250);

      state.heartbeatTimer = timer;
      state.timers.add(timer);
    }

    function acquireResponseContainer() {
      if (
        state.responseContainer &&
        state.responseContainer.isConnected !== false
      ) {
        return state.responseContainer;
      }

      const responses = deepQueryAll(root, strictResponseSelector);
      const candidates = responses.filter(element => !initialResponses.has(element));
      if (!candidates.length) return null;

      const container = candidates[candidates.length - 1];
      state.responseContainer = container;
      state.modelTurn = container;
      state.modelTurnObservedAt = Date.now();
      state.generationStarted = true;

      emitState('model_turn_acquired', {
        responseIndex: responses.length - 1,
      });
      // A criação de uma resposta estrita do modelo é evidência forte de submit.
      confirmSubmission('response_created');

      if (state.responseObserver) {
        try { state.responseObserver.disconnect(); } catch (_e) {}
      }
      state.responseObserver = new MutationObserverImpl(scheduleInspect);
      try {
        state.responseObserver.observe(container, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['src', 'data-src', 'aria-hidden', 'style', 'class'],
        });
      } catch (_e) {}

      return container;
    }

    function inspectEditor() {
      if (state.submissionConfirmed || !initialEditorText) return;
      let current = null;
      try {
        current = typeof getEditor === 'function' ? getEditor() : editor;
      } catch (_e) {}
      if (!current) return;
      const currentText = String(current.textContent || '').trim();
      if (currentText.length === 0) confirmSubmission('editor_consumed');
    }

    function inspectControls() {
      const visibleStop = domApi.findVisibleStopButton(root);
      if (visibleStop) {
        markGenerationActive('stop_visible');
      } else if (
        state.generationActiveObserved &&
        state.responseContainer &&
        state.responseContainer.isConnected !== false
      ) {
        if (!state.generationFinished) {
          state.generationFinished = true;
          emitState('generation_finished');
        }
      }

      const sendControls = safeQueryAll(root, SELECTORS.SEND)
        .filter(domApi.isElementVisible);
      const hasEnabledSend = sendControls.some(domApi.isControlEnabled);
      if (hasEnabledSend) state.sendEnabledObserved = true;

      const transitionedToBusy =
        state.sendEnabledObserved &&
        sendControls.length > 0 &&
        sendControls.every(element => !domApi.isControlEnabled(element));

      if (transitionedToBusy) {
        confirmSubmission('send_busy');
        markGenerationActive('send_busy');
      }
    }

    function inspectErrors() {
      const errors = deepQueryAll(root, SELECTORS.ERROR);
      for (const element of errors) {
        if (!domApi.isElementVisible(element)) continue;
        const text = String(element.innerText || element.textContent || '').trim();
        if (!text || initialErrors.has(text)) continue;
        fail(text);
        return;
      }
    }

    function strongImageUrl(src) {
      const value = String(src || '');
      return value.startsWith('blob:') ||
        value.startsWith('data:image/') ||
        value.includes('googleusercontent.com/gg-dl/') ||
        value.includes('googleusercontent.com/rd-gg-dl/') ||
        value.includes('gemini-result-image');
    }

    function highConfidenceGeneratedAssetUrl(src) {
      const value = String(src || '');
      return value.includes('googleusercontent.com/gg-dl/') ||
        value.includes('googleusercontent.com/rd-gg-dl/') ||
        value.includes('gemini-result-image');
    }


    function isCandidateImage(image, container) {
      if (!image || !container) return false;
      if (!state.submissionConfirmed) return false;
      if (quarantinedInputElements.has(image)) return false;
      if (domApi.isUserTurnImage?.(image)) return false;

      const owner = domApi.getStrictModelResponseContainer?.(image);
      if (!owner || owner !== container) return false;

      const src = domApi.getImageSource(image);
      if (
        !src ||
        state.initialImageSources.has(src) ||
        domApi.isIgnoredGeminiImageSource(src)
      ) {
        return false;
      }

      const width = Number(image.naturalWidth || image.width || 0);
      const height = Number(image.naturalHeight || image.height || 0);

      if (strongImageUrl(src)) return true;
      if (image.complete === false && width <= 0 && height <= 0) return false;
      return width > 0 && height > 0;
    }

    function isHighConfidenceFallbackImage(image) {
      if (!image || !state.submissionConfirmed) return false;
      if (quarantinedInputElements.has(image)) return false;
      if (domApi.isUserTurnImage?.(image)) return false;
      if (domApi.isInsideInputArea?.(image)) return false;

      const manualPanel = domApi.closestComposed?.(image, '#mt-gemini-assist');
      if (manualPanel) return false;

      const src = domApi.getImageSource(image);
      if (
        !src ||
        state.initialImageSources.has(src) ||
        domApi.isIgnoredGeminiImageSource(src) ||
        !highConfidenceGeneratedAssetUrl(src)
      ) {
        return false;
      }

      const broadOwner = domApi.getModelResponseContainer?.(image) || null;
      if (!state.generationActiveObserved && !broadOwner) return false;

      return true;
    }

    function inspectHighConfidenceFallbackResult() {
      const images = deepQueryAll(root, 'img');

      for (let index = images.length - 1; index >= 0; index -= 1) {
        const image = images[index];
        if (!isHighConfidenceFallbackImage(image)) continue;

        const src = domApi.getImageSource(image);
        const owner =
          domApi.getModelResponseContainer?.(image) ||
          image.parentElement ||
          image;

        state.responseContainer = owner;
        state.modelTurn = owner;
        state.modelTurnObservedAt = Date.now();
        state.fallbackOwnerUsed = true;

        emitState('model_turn_fallback_acquired', {
          reason: 'high_confidence_generated_asset',
          urlKind: String(src).split(':', 1)[0] || 'unknown',
        });
        emitState('result_candidate', {
          urlKind: String(src).split(':', 1)[0] || 'unknown',
          strongUrl: true,
          ownership: 'high_confidence_fallback',
        });

        if (setResult(image, src)) return true;
      }

      return false;
    }

    function inspectResult() {
      if (!state.submissionConfirmed) return;
      const container = acquireResponseContainer();
      if (!container) {
        inspectHighConfidenceFallbackResult();
        return;
      }

      const images = deepQueryAll(container, 'img');
      if (images.length > 0 && !state.resultDomObserved) {
        state.resultDomObserved = true;
        emitState('result_dom_seen', { imageCount: images.length });
      }

      for (let index = images.length - 1; index >= 0; index -= 1) {
        const image = images[index];
        const src = domApi.getImageSource(image);
        if (src && !state.seenResultSources.has(src)) {
          state.seenResultSources.add(src);
          emitState('result_image_seen', {
            urlKind: String(src).split(':', 1)[0] || 'unknown',
            strongUrl: strongImageUrl(src),
          });
        }

        if (!isCandidateImage(image, container)) continue;
        emitState('result_candidate', {
          urlKind: String(src).split(':', 1)[0] || 'unknown',
          strongUrl: strongImageUrl(src),
        });
        if (setResult(image, src)) return;
      }

      if (!state.resultUrl) inspectHighConfidenceFallbackResult();
    }

    function inspect() {
      if (state.cleanedUp || state.done) return;
      state.inspectCount += 1;
      discoverShadowRoots();

      inspectEditor();
      if (state.cleanedUp || state.done) return;

      acquireResponseContainer();
      inspectControls();
      if (state.cleanedUp || state.done) return;

      inspectErrors();
      if (state.cleanedUp || state.done) return;

      inspectResult();
    }

    function scheduleInspect() {
      if (state.cleanedUp || state.done || state.inspectionScheduled) return;
      state.inspectionScheduled = true;
      queueMicrotaskFn(() => {
        state.inspectionScheduled = false;
        if (state.cleanedUp || state.done) return;
        inspect();
      });
    }

    function start() {
      if (state.cleanedUp || state.ready) return api;
      const observeRoot = root.body || root.documentElement || root;
      state.observer = new MutationObserverImpl(scheduleInspect);
      observeMutationRoot(observeRoot);
      discoverShadowRoots();
      state.ready = true;
      registryOwner.__mtGeminiObservers[jobId] = api;
      emitState('ready', { initialResponseCount: state.initialResponseCount });
      inspect();
      scheduleHeartbeat();
      return api;
    }

    function waitForSubmission(timeoutMs = 5000) {
      if (state.submissionConfirmed) {
        return Promise.resolve({
          confirmed: true,
          reason: state.submissionReason,
        });
      }
      if (state.error) {
        return Promise.reject(createError('GEMINI_UI_ERROR', state.error));
      }
      if (state.cleanedUp || state.done) {
        return Promise.reject(createError('OBSERVER_STOPPED', 'Observer já finalizado'));
      }

      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeoutFn(() => {
          submissionWaiters.delete(waiter);
          state.timers.delete(waiter.timer);
          reject(createError(
            'GEMINI_SUBMISSION_NOT_CONFIRMED',
            'Envio não foi confirmado pela UI'
          ));
        }, timeoutMs);
        state.timers.add(waiter.timer);
        submissionWaiters.add(waiter);
      });
    }

    function waitForResult(timeoutMs = 4 * 60 * 1000) {
      if (state.resultUrl) {
        return Promise.resolve({
          image: state.resultImage,
          url: state.resultUrl,
        });
      }
      if (state.error) {
        return Promise.reject(createError('GEMINI_UI_ERROR', state.error));
      }
      if (state.cleanedUp || state.done) {
        return Promise.reject(createError('OBSERVER_STOPPED', 'Observer já finalizado'));
      }

      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeoutFn(() => {
          resultWaiters.delete(waiter);
          state.timers.delete(waiter.timer);
          reject(createError(
            'GEMINI_RESULT_TIMEOUT',
            'Tempo limite aguardando resultado do Gemini'
          ));
        }, timeoutMs);
        state.timers.add(waiter.timer);
        resultWaiters.add(waiter);
      });
    }

    function stop() {
      if (state.cleanedUp) return false;
      state.cleanedUp = true;
      state.done = true;

      if (state.observer) {
        try { state.observer.disconnect(); } catch (_e) {}
        state.observer = null;
      }
      state.observedMutationRoots.clear();
      state.heartbeatTimer = null;
      if (state.responseObserver) {
        try { state.responseObserver.disconnect(); } catch (_e) {}
        state.responseObserver = null;
      }

      for (const timer of Array.from(state.timers)) removeTimer(timer);
      settleWaiters(
        submissionWaiters,
        'reject',
        createError('OBSERVER_STOPPED', 'Observer interrompido')
      );
      settleWaiters(
        resultWaiters,
        'reject',
        createError('OBSERVER_STOPPED', 'Observer interrompido')
      );

      if (registryOwner.__mtGeminiObservers[jobId] === api) {
        delete registryOwner.__mtGeminiObservers[jobId];
      }
      emitState('cleanup');
      return true;
    }

    function getState() {
      return state;
    }

    // Mantido para seleção manual explícita. O usuário é a fonte de ownership
    // nesse caminho; a automação automática nunca chama isto para IMG global.
    function acceptResult(image, url) {
      if (!state.submissionConfirmed) {
        confirmSubmission('manual_selection');
      }
      if (!state.modelTurn && image) {
        state.modelTurn = domApi.getStrictModelResponseContainer?.(image) || null;
      }
      if (!state.modelTurn) {
        // Seleção manual sem elemento DOM (ex.: blob escolhido pelo painel)
        // usa um sentinel de ownership humano.
        state.modelTurn = { manual: true };
      }
      return setResult(image || null, url);
    }

    const api = {
      start,
      stop,
      inspect,
      scheduleInspect,
      waitForSubmission,
      waitForResult,
      acceptResult,
      getState,
    };

    return api;
  }

  const api = {
    createGeminiObserver,
    deepQueryAll,
  };
  scope.MangaTranslatorGeminiObserver = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
