'use strict';
// gemini/attachment.js — Upload de imagem com confirmação observável.
//
// Invariantes V3:
// 1) dispatch de paste/change/drop é somente tentativa;
// 2) apenas evidência ligada ao composer/attachment UI confirma o arquivo;
// 3) sinal parcial interrompe novos dispatches para evitar uploads duplicados;
// 4) ausência de confirmação nunca é promovida a sucesso pelo chamador.

(function(scope) {
  let domApi = scope.MangaTranslatorGeminiDom || null;
  if (!domApi && typeof require === 'function') {
    try { domApi = require('./dom.js'); } catch (_e) {}
  }
  if (!domApi) throw new Error('MangaTranslatorGeminiDom indisponível');

  const INPUT_AREA_SELECTOR =
    'rich-textarea, .input-area, .chat-input-container, .chat-input, input-area';

  function getSearchRoot(root) {
    return root && (root.body || root.documentElement || root);
  }

  function safeClosest(element, selector) {
    try { return element?.closest?.(selector) || null; } catch (_e) { return null; }
  }

  function isImageFileInput(input) {
    if (!input || input.disabled === true || input.getAttribute?.('aria-disabled') === 'true') {
      return false;
    }
    const accept = String(input.accept || input.getAttribute?.('accept') || '').toLowerCase().trim();
    return !accept || accept.includes('image') || accept.includes('*/*');
  }

  function scoreFileInput(input, composerRoot) {
    if (!isImageFileInput(input)) return -Infinity;
    let score = 0;

    if (composerRoot) {
      try {
        if (composerRoot === input || composerRoot.contains?.(input)) score += 100;
      } catch (_e) {}
    }
    if (safeClosest(input, INPUT_AREA_SELECTOR)) score += 70;

    const accept = String(input.accept || input.getAttribute?.('accept') || '').toLowerCase();
    if (accept.includes('image')) score += 30;

    const name = [
      input.getAttribute?.('aria-label'),
      input.getAttribute?.('data-test-id'),
      input.getAttribute?.('data-testid'),
      input.getAttribute?.('name'),
      input.id,
      typeof input.className === 'string' ? input.className : '',
    ].filter(Boolean).join(' ').toLowerCase();

    if (/attach|upload|image|file|media|anex/.test(name)) score += 20;
    return score;
  }

  function findFileInputsDeep(root, composerRoot = null) {
    const inputs = domApi.findAllDeep(root, element =>
      String(element.tagName || '').toUpperCase() === 'INPUT' &&
      String(element.type || element.getAttribute?.('type') || '').toLowerCase() === 'file'
    ).filter(isImageFileInput);

    return inputs
      .map((input, index) => ({ input, index, score: scoreFileInput(input, composerRoot) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => item.input);
  }

  function describeAttachmentContainer(element) {
    if (!element) return null;
    const tag = String(element.tagName || '').toLowerCase();
    const tid = String(
      element.getAttribute?.('data-test-id') ||
      element.getAttribute?.('data-testid') ||
      ''
    ).toLowerCase();
    const className = typeof element.className === 'string'
      ? element.className.toLowerCase()
      : '';

    const isContainer =
      tag === 'file-preview' ||
      tag === 'attachment-card' ||
      tid.includes('attachment') ||
      tid.includes('preview') ||
      className.includes('file-preview') ||
      className.includes('attachment-preview') ||
      className.includes('image-preview') ||
      className.includes('attachment-container');

    if (!isContainer) return null;

    let rect = null;
    try { rect = element.getBoundingClientRect(); } catch (_e) {}
    if (rect && rect.width <= 20 && rect.height <= 20) return null;

    return { tag, tid, className };
  }

  function imageLooksReady(img) {
    if (!img) return false;
    const src = domApi.getImageSource(img);
    if (!src || domApi.isIgnoredGeminiImageSource(src)) return false;

    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);

    // Blob/data são previews comuns. Ainda assim só são aceitos quando o
    // elemento está ligado ao composer/container de attachment.
    if (src.startsWith('blob:') || src.startsWith('data:image/')) return true;
    if (img.complete === false && width <= 0 && height <= 0) return false;
    return width > 20 && height > 20;
  }

  function listAttachmentEvidence(root, composerRoot = null) {
    const searchRoot = getSearchRoot(root);
    if (!searchRoot) return [];

    const evidence = [];
    const seenImages = new Set();

    const containers = domApi.findAllDeep(searchRoot, element =>
      Boolean(describeAttachmentContainer(element))
    );

    for (const container of containers) {
      const meta = describeAttachmentContainer(container);
      if (!meta) continue;

      const img = container.querySelector ? container.querySelector('img') : null;
      const imageSource = img ? domApi.getImageSource(img) : '';
      const ready = imageLooksReady(img);

      evidence.push({
        el: container,
        img,
        composer: safeClosest(container, INPUT_AREA_SELECTOR) || composerRoot || null,
        type: 'container',
        selector: meta.tag || 'attachment-container',
        imageSource,
        strength: ready ? 'confirmed' : 'pending',
      });
      if (img) seenImages.add(img);
    }

    const images = domApi.findAllDeep(searchRoot, element =>
      String(element.tagName || '').toUpperCase() === 'IMG'
    );

    for (const img of images) {
      if (seenImages.has(img)) continue;
      const src = domApi.getImageSource(img);
      if (!src || domApi.isIgnoredGeminiImageSource(src)) continue;

      const inputArea = safeClosest(img, INPUT_AREA_SELECTOR);
      const attachmentContainer = safeClosest(
        img,
        'file-preview, attachment-card, [data-test-id*="attachment"], [data-testid*="attachment"], ' +
        '[data-test-id*="preview"], [data-testid*="preview"], .file-preview, .attachment-preview, ' +
        '.image-preview, .attachment-container'
      );

      let insidePreferredComposer = false;
      if (composerRoot) {
        try {
          insidePreferredComposer = composerRoot === img || composerRoot.contains?.(img);
        } catch (_e) {}
      }

      // Nunca aceitar blob/data global só por ser "novo". A mídia precisa ter
      // ownership estrutural do composer ou de um container de attachment.
      if (!inputArea && !attachmentContainer && !insidePreferredComposer) continue;
      if (!imageLooksReady(img)) continue;

      evidence.push({
        el: img,
        img,
        composer: inputArea || composerRoot || null,
        type: 'input-img',
        selector: inputArea ? 'input-area img' : 'attachment img',
        imageSource: src,
        strength: 'confirmed',
      });
      seenImages.add(img);
    }

    return evidence;
  }

  function evidenceSignature(evidence) {
    if (!evidence || !evidence.el) return '';
    const element = evidence.el;
    const image = evidence.img || (
      element.querySelector ? element.querySelector('img') : null
    );

    const imageSource = image ? domApi.getImageSource(image) : '';
    const dataTestId = String(
      element.getAttribute?.('data-test-id') ||
      element.getAttribute?.('data-testid') ||
      ''
    );
    const childCount = Number(element.childElementCount || 0);
    const text = String(element.textContent || '').trim().slice(0, 160);

    return [
      evidence.type || '',
      evidence.selector || '',
      evidence.strength || '',
      dataTestId,
      childCount,
      imageSource,
      text,
    ].join('|');
  }

  function captureAttachmentBaseline(root, composerRoot = null) {
    const signatures = new Map();
    for (const evidence of listAttachmentEvidence(root, composerRoot)) {
      signatures.set(evidence.el, evidenceSignature(evidence));
    }
    return { signatures };
  }

  function isEvidenceNewOrChanged(evidence, baseline) {
    if (!baseline || !(baseline.signatures instanceof Map)) return true;
    if (!baseline.signatures.has(evidence.el)) return true;
    return baseline.signatures.get(evidence.el) !== evidenceSignature(evidence);
  }

  function findAttachmentEvidenceDeep(root, baseline = null, composerRoot = null) {
    const changed = listAttachmentEvidence(root, composerRoot)
      .filter(item => !baseline || isEvidenceNewOrChanged(item, baseline));

    const confirmed = changed.find(item => item.strength === 'confirmed') || null;
    const pending = changed.find(item => item.strength === 'pending') || null;
    return { confirmed, pending };
  }

  function findAttachmentThumbnailDeep(root, baseline = null, composerRoot = null) {
    return findAttachmentEvidenceDeep(root, baseline, composerRoot).confirmed;
  }

  function buildDataTransfer(file) {
    const DataTransferImpl = scope.DataTransfer;
    if (typeof DataTransferImpl === 'function') {
      try {
        const transfer = new DataTransferImpl();
        transfer.items.add(file);
        return transfer;
      } catch (_e) {}
    }

    const files = [file];
    const items = [];
    items.add = item => {
      if (!files.includes(item)) files.push(item);
      return item;
    };
    return { files, items };
  }

  function createClipboardEvent(transfer) {
    if (typeof scope.ClipboardEvent === 'function') {
      try {
        return new scope.ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: transfer,
        });
      } catch (_e) {}
    }

    const event = new scope.Event('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(event, 'clipboardData', {
        value: transfer,
        configurable: true,
      });
    } catch (_e) {}
    return event;
  }

  function createDropEvent(transfer) {
    if (typeof scope.DragEvent === 'function') {
      try {
        return new scope.DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer,
        });
      } catch (_e) {}
    }

    const event = new scope.Event('drop', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(event, 'dataTransfer', {
        value: transfer,
        configurable: true,
      });
    } catch (_e) {}
    return event;
  }

  function focusForAttachment({ editor, editorRoot, windowRef = scope.window || scope }) {
    let attempted = false;

    for (const element of new Set([editor, editorRoot].filter(Boolean))) {
      try {
        element.focus?.({ preventScroll: true });
        attempted = true;
      } catch (_e) {
        try { element.focus?.(); attempted = true; } catch (_e2) {}
      }

      for (const type of ['focus', 'focusin']) {
        try {
          const FocusEventImpl = scope.FocusEvent || scope.Event;
          element.dispatchEvent(new FocusEventImpl(type, {
            bubbles: true,
            composed: true,
          }));
          attempted = true;
        } catch (_e) {}
      }
    }

    try {
      windowRef?.dispatchEvent?.(new scope.Event('focus'));
      attempted = true;
    } catch (_e) {}

    return attempted;
  }

  function dispatchPaste({ editor, editorRoot, transfer }) {
    // Último recurso: um único paste sintético no alvo mais específico.
    // Disparar no editor e no wrapper podia duplicar handlers internos do Gemini.
    const target = editor || editorRoot;
    if (!target || typeof target.dispatchEvent !== 'function') return false;
    try {
      target.dispatchEvent(createClipboardEvent(transfer));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function assignFileInputs({ root, editorRoot, transfer }) {
    const searchRoot = getSearchRoot(root);
    const inputs = findFileInputsDeep(searchRoot, editorRoot);
    if (!inputs.length) return false;

    // Um upload deve atingir um único input escolhido por relevância, nunca
    // todos os inputs[type=file] internos da página.
    const input = inputs[0];
    try {
      input.files = transfer.files;
      input.dispatchEvent(new scope.Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new scope.Event('change', { bubbles: true, composed: true }));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function dispatchDrop({ editorRoot, transfer }) {
    if (!editorRoot || typeof editorRoot.dispatchEvent !== 'function') return false;
    try {
      editorRoot.dispatchEvent(createDropEvent(transfer));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function dispatchAttachmentAttempt({
    editor,
    editorRoot,
    root,
    transfer,
    method = 'file_input',
  }) {
    let attempted = false;

    if (method === 'file_input') {
      attempted = assignFileInputs({ root, editorRoot, transfer });
    } else if (method === 'drop') {
      attempted = dispatchDrop({ editorRoot, transfer });
    } else if (method === 'paste') {
      attempted = dispatchPaste({ editor, editorRoot, transfer });
    }

    return {
      attempted,
      methods: attempted ? [method] : [],
    };
  }

  function createAttachmentConfirmation({
    root,
    composerRoot = null,
    baseline = captureAttachmentBaseline(root, composerRoot),
    timeoutMs = 15000,
    MutationObserverImpl = scope.MutationObserver,
    setTimeoutFn = scope.setTimeout?.bind(scope) || setTimeout,
    clearTimeoutFn = scope.clearTimeout?.bind(scope) || clearTimeout,
  } = {}) {
    if (!root || typeof MutationObserverImpl !== 'function') {
      const promise = Promise.resolve({
        status: 'failed',
        confirmed: false,
        evidence: null,
        signalObserved: false,
      });
      return {
        promise,
        inspect: () => null,
        hasSignal: () => false,
        getSignal: () => null,
        stop: () => false,
      };
    }

    let settled = false;
    let observer = null;
    let timer = null;
    let resolvePromise = null;
    let lastSignal = null;

    const promise = new Promise(resolve => {
      resolvePromise = resolve;
    });

    const finish = result => {
      if (settled) return false;
      settled = true;
      if (observer) {
        try { observer.disconnect(); } catch (_e) {}
        observer = null;
      }
      if (timer !== null) {
        try { clearTimeoutFn(timer); } catch (_e) {}
        timer = null;
      }
      resolvePromise(result);
      return true;
    };

    const inspect = () => {
      if (settled) return null;
      const found = findAttachmentEvidenceDeep(root, baseline, composerRoot);

      if (found.pending) lastSignal = found.pending;
      if (!found.confirmed) return found.pending || null;

      lastSignal = found.confirmed;
      finish({
        status: 'confirmed',
        confirmed: true,
        evidence: found.confirmed,
        signalObserved: true,
      });
      return found.confirmed;
    };

    const observeRoot = getSearchRoot(root);
    observer = new MutationObserverImpl(inspect);
    observer.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'src',
        'data-src',
        'class',
        'style',
        'aria-hidden',
        'data-test-id',
        'data-testid',
      ],
    });

    timer = setTimeoutFn(() => finish({
      status: 'failed',
      confirmed: false,
      evidence: null,
      signalObserved: Boolean(lastSignal),
      lastSignal,
    }), timeoutMs);

    inspect();

    return {
      promise,
      inspect,
      hasSignal: () => Boolean(lastSignal),
      getSignal: () => lastSignal,
      stop() {
        return finish({
          status: 'failed',
          confirmed: false,
          evidence: null,
          signalObserved: Boolean(lastSignal),
          lastSignal,
        });
      },
    };
  }

  function waitForAttachment(options = {}) {
    return createAttachmentConfirmation(options).promise;
  }

  async function attachFile({
    file,
    editor,
    editorRoot = editor,
    root = scope.document,
    timeoutMs = 15000,
    retryAfterMs = 2500,
    maxDispatches = 3,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    MutationObserverImpl = scope.MutationObserver,
    setTimeoutFn = scope.setTimeout?.bind(scope) || setTimeout,
    clearTimeoutFn = scope.clearTimeout?.bind(scope) || clearTimeout,
  } = {}) {
    const startedAt = Date.now();

    if (!file || !editor || !root || typeof MutationObserverImpl !== 'function') {
      return {
        status: 'failed',
        confirmed: false,
        attempted: false,
        evidence: null,
        signalObserved: false,
        methodsAttempted: [],
        attempts: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const baseline = captureAttachmentBaseline(root, editorRoot);
    const confirmation = createAttachmentConfirmation({
      root,
      composerRoot: editorRoot,
      baseline,
      timeoutMs,
      MutationObserverImpl,
      setTimeoutFn,
      clearTimeoutFn,
    });

    focusForAttachment({ editor, editorRoot });

    const transfer = buildDataTransfer(file);
    const methodsAttempted = new Set();
    let attempted = false;
    let attempts = 0;

    // Um método por vez. O caminho preferido não usa clipboard:
    // file input -> drop -> paste (último recurso).
    const methodPlan = ['file_input', 'drop', 'paste'];

    for (const method of methodPlan) {
      if (attempts >= maxDispatches) break;
      if (confirmation.hasSignal()) break;

      const result = dispatchAttachmentAttempt({
        editor,
        editorRoot,
        root,
        transfer,
        method,
      });
      if (!result.attempted) continue;

      attempts += 1;
      attempted = true;
      result.methods.forEach(name => methodsAttempted.add(name));
      confirmation.inspect();

      const early = await Promise.race([
        confirmation.promise.then(value => ({ kind: 'result', result: value })),
        sleep(retryAfterMs).then(() => ({ kind: 'retry' })),
      ]);

      if (early.kind === 'result') {
        return {
          ...early.result,
          attempted,
          methodsAttempted: Array.from(methodsAttempted),
          attempts,
          elapsedMs: Date.now() - startedAt,
        };
      }

      // Se o Gemini já expôs chip/spinner/container de attachment, o upload
      // está em andamento e não devemos disparar outro mecanismo.
      if (confirmation.hasSignal()) break;
    }

    if (!attempted) {
      confirmation.stop();
    }

    const result = await confirmation.promise;
    return {
      ...result,
      attempted,
      methodsAttempted: Array.from(methodsAttempted),
      attempts,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const api = {
    findFileInputsDeep,
    listAttachmentEvidence,
    captureAttachmentBaseline,
    findAttachmentEvidenceDeep,
    findAttachmentThumbnailDeep,
    buildDataTransfer,
    focusForAttachment,
    dispatchPaste,
    assignFileInputs,
    dispatchDrop,
    dispatchAttachmentAttempt,
    createAttachmentConfirmation,
    waitForAttachment,
    attachFile,
  };

  scope.MangaTranslatorGeminiAttachment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
