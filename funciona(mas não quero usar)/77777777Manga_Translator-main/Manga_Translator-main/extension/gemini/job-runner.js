'use strict';
// gemini/job-runner.js — orquestração de um job Gemini já reivindicado.
//
// Este módulo recebe dependências explicitamente. Ele não faz claim e não abre
// automação por conta própria: content_gemini.js continua responsável por
// bootstrap/claim/keepalive/message handlers.

(function(scope) {
  function createGeminiJobRunner({
    root = scope.document || null,
    pageWindow = scope.window || null,
    runtime = scope.chrome?.runtime || null,
    storage = scope.chrome?.storage?.local || null,
    domApi = scope.MangaTranslatorGeminiDom,
    observerApi = scope.MangaTranslatorGeminiObserver,
    editorApi = scope.MangaTranslatorGeminiEditor,
    attachmentApi = scope.MangaTranslatorGeminiAttachment,
    temporaryChatApi = scope.MangaTranslatorGeminiTemporaryChat,
    resultExtractor = null,
    deletionController = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    sendLog = function() {},
    getUrlLogMetadata = () => ({}),
    debugConsole = function() {},
    reportProgress = function() {},
    openKeepAlive = function() {},
    closeKeepAlive = function() {},
    FileImpl = scope.File,
    DataUrlAtob = scope.atob ? scope.atob.bind(scope) : null,
    setIntervalFn = scope.setInterval ? scope.setInterval.bind(scope) : setInterval,
    clearIntervalFn = scope.clearInterval ? scope.clearInterval.bind(scope) : clearInterval,
  } = {}) {
    if (!root || !pageWindow || !runtime || !storage) {
      throw new Error('JobRunner requer document/window/runtime/storage');
    }
    if (!domApi || !observerApi || !editorApi || !attachmentApi || !temporaryChatApi) {
      throw new Error('JobRunner requer módulos Gemini DOM/Observer/Editor/Attachment/TemporaryChat');
    }
    if (!resultExtractor || !deletionController) {
      throw new Error('JobRunner requer resultExtractor e deletionController');
    }

    let activeObserver = null;

    function getAntiThrottleModeForExecutionMode(executionMode) {
      return executionMode === 'minimized_window' || executionMode === 'background_delete'
        ? 'balanced'
        : 'minimal';
    }

    function setAntiThrottleMode(mode) {
      const normalized = ['minimal', 'balanced', 'legacy'].includes(mode)
        ? mode
        : 'minimal';
      const CustomEventImpl = scope.CustomEvent || pageWindow.CustomEvent;
      if (typeof CustomEventImpl !== 'function' || typeof pageWindow.dispatchEvent !== 'function') {
        return normalized;
      }

      try {
        pageWindow.dispatchEvent(new CustomEventImpl(
          'MANGA_TRANSLATOR_ANTI_THROTTLE_SET_MODE',
          { detail: { mode: normalized } }
        ));
      } catch (_e) {}
      return normalized;
    }

    function storageGet(keys) {
      return new Promise(resolve => {
        try {
          storage.get(keys, data => resolve(data || {}));
        } catch (_e) {
          resolve({});
        }
      });
    }

    function sendRuntimeMessage(message) {
      return new Promise(resolve => {
        try {
          runtime.sendMessage(message, response => {
            const error = runtime.lastError;
            if (error) {
              resolve({ ok: false, error: error.message || String(error) });
              return;
            }
            resolve(response || { ok: true });
          });
        } catch (error) {
          resolve({ ok: false, error: error?.message || String(error) });
        }
      });
    }

    function dataUrlPayload(value) {
      const raw = String(value || '');
      if (!raw.startsWith('data:image/')) return '';
      const comma = raw.indexOf(',');
      if (comma < 0) return '';
      return raw.slice(comma + 1).replace(/\s+/g, '');
    }

    function sameImagePayload(first, second) {
      const a = dataUrlPayload(first);
      const b = dataUrlPayload(second);
      return Boolean(a && b && a === b);
    }

    function dataURLtoFile(dataurl, filename) {
      const raw = String(dataurl || '');
      const commaIndex = raw.indexOf(',');
      if (commaIndex === -1) {
        throw new Error('dataURL malformada: sem vírgula separadora');
      }

      const header = raw.slice(0, commaIndex);
      const mimeMatch = header.match(/:(.*?);/);
      if (!mimeMatch || !mimeMatch[1]) {
        throw new Error('dataURL malformada: MIME não encontrado');
      }
      if (typeof DataUrlAtob !== 'function' || typeof FileImpl !== 'function') {
        throw new Error('APIs de arquivo indisponíveis');
      }

      const binary = DataUrlAtob(raw.slice(commaIndex + 1));
      let length = binary.length;
      const bytes = new Uint8Array(length);
      while (length--) bytes[length] = binary.charCodeAt(length);
      return new FileImpl([bytes], filename, { type: mimeMatch[1] });
    }

    function waitForElement(selector, timeout = 20_000) {
      const existing = root.querySelector(selector);
      if (existing) return Promise.resolve(existing);

      const MutationObserverImpl = scope.MutationObserver || pageWindow.MutationObserver;
      if (typeof MutationObserverImpl !== 'function') {
        return Promise.resolve(null);
      }

      return new Promise(resolve => {
        let timer = null;
        let observer = null;
        let settled = false;

        const finish = element => {
          if (settled) return;
          settled = true;
          if (timer !== null) {
            try { scope.clearTimeout(timer); } catch (_e) {}
          }
          if (observer) {
            try { observer.disconnect(); } catch (_e) {}
          }
          resolve(element || null);
        };

        timer = scope.setTimeout(
          () => finish(root.querySelector(selector)),
          timeout
        );

        observer = new MutationObserverImpl(() => {
          const element = root.querySelector(selector);
          if (element) finish(element);
        });

        const observeRoot = root.body || root.documentElement;
        if (!observeRoot) {
          finish(null);
          return;
        }
        observer.observe(observeRoot, { childList: true, subtree: true });
      });
    }

    function getImageSource(image) {
      return domApi.getImageSource(image);
    }

    function isIgnoredGeminiImageSource(src) {
      return domApi.isIgnoredGeminiImageSource(src);
    }

    function isModelResponseImage(image) {
      return domApi.isModelResponseImage(image);
    }

    function isStrongGeneratedImageUrl(src) {
      const value = String(src || '');
      return value.includes('gemini-result-image') ||
        value.includes('googleusercontent.com/gg-dl/') ||
        value.includes('googleusercontent.com/rd-gg-dl/') ||
        value.startsWith('blob:https://gemini.google.com/') ||
        value.startsWith('blob:http://127.0.0.1/') ||
        value.startsWith('data:image/');
    }

    function isLikelyGeneratedImage(image, ignoreImages = new Set()) {
      const src = getImageSource(image);
      if (!src || ignoreImages.has(src) || isIgnoredGeminiImageSource(src)) return false;

      if (isModelResponseImage(image)) return true;

      if (isStrongGeneratedImageUrl(src)) return true;

      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;

      if (
        src.includes('googleusercontent.com') &&
        !isIgnoredGeminiImageSource(src) &&
        width <= 0 &&
        height <= 0
      ) {
        return true;
      }

      if (width <= 0 || height <= 0) return false;
      if (image.complete === false && height <= 0) return false;

      const maxSide = Math.max(width, height);
      const minSide = Math.min(width, height);
      const area = width * height;
      return maxSide >= 256 && minSide >= 40 && area >= 12_000;
    }

    function isManualSelectableImage(image, ignoreImages = new Set()) {
      const src = getImageSource(image);
      if (!src || ignoreImages.has(src) || isIgnoredGeminiImageSource(src)) return false;
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      return width > 0 && height > 0 && Math.max(width, height) >= 40;
    }

    function findGeneratedResultImages(ignoreImages = new Set()) {
      const images = domApi.findAllDeep(
        root.body || root.documentElement,
        element => String(element.tagName || '').toUpperCase() === 'IMG'
      );

      images.forEach(image => {
        if (image.getAttribute?.('loading') === 'lazy') {
          image.removeAttribute('loading');
          image.setAttribute('loading', 'eager');
        }
        if (image.dataset?.src) image.src = image.dataset.src;
      });

      return images.filter(image => isLikelyGeneratedImage(image, ignoreImages));
    }

    function setManualGeminiResultUrl(url, source = 'manual') {
      pageWindow.__mangaTranslatorManualGeminiResultUrl = url;

      const observer = activeObserver || pageWindow.__mangaTranslatorActiveGeminiObserver;
      if (observer && typeof observer.acceptResult === 'function') {
        observer.acceptResult(null, url);
      }

      const status = root.getElementById('mt-gemini-assist-status');
      if (status) {
        status.textContent = 'Imagem marcada. A extensão vai usar esse resultado.';
      }

      sendLog(
        'info',
        'GEMINI_MANUAL_RESULT',
        'Imagem marcada manualmente no Gemini',
        { source, ...getUrlLogMetadata(url) }
      );
    }

    function removeGeminiManualPanel() {
      const existing = root.getElementById('mt-gemini-assist');
      if (existing) existing.remove();

      if (pageWindow.__mangaTranslatorManualPickHandler) {
        root.removeEventListener(
          'click',
          pageWindow.__mangaTranslatorManualPickHandler,
          true
        );
        pageWindow.__mangaTranslatorManualPickHandler = null;
      }

      domApi.findAllDeep(
        root.body || root.documentElement,
        element => element?.getAttribute?.('data-mt-gemini-pickable') === 'true'
      ).forEach(image => {
        image.style.outline = '';
        image.style.outlineOffset = '';
        image.removeAttribute('data-mt-gemini-pickable');
      });
    }

    function reportManualIntervention(job, source) {
      if (!job) return;
      if (pageWindow.__mangaTranslatorManualInterventionJobId === job.jobId) return;

      pageWindow.__mangaTranslatorManualInterventionJobId = job.jobId || true;
      sendLog(
        'error',
        'GEMINI_MANUAL_INTERVENTION_REQUIRED',
        'ERRO GRAVE: a detecção automática falhou e o usuário precisou interagir manualmente com o resultado do Gemini.',
        {
          source,
          index: Number.isFinite(Number(job.index)) ? Number(job.index) : null,
          jobIdPrefix: String(job.jobId || '').slice(0, 8),
          executionMode: job.executionMode || null,
        }
      );
    }

    function createGeminiManualPanel(job, getIgnoreImages) {
      removeGeminiManualPanel();
      pageWindow.__mangaTranslatorManualGeminiResultUrl = '';
      pageWindow.__mangaTranslatorManualInterventionJobId = null;

      const panel = root.createElement('div');
      panel.id = 'mt-gemini-assist';
      panel.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:2147483647',
        'width:260px',
        'background:#111',
        'color:#fff',
        'border:1px solid #333',
        'border-radius:8px',
        'box-shadow:0 10px 28px rgba(0,0,0,0.45)',
        'font-family:Arial,sans-serif',
        'font-size:12px',
        'padding:12px',
        'line-height:1.35',
      ].join(';');

      panel.innerHTML = [
        '<div style="font-weight:700;margin-bottom:4px;">Manga Translator</div>',
        '<div id="mt-gemini-assist-description" style="color:#aaa;margin-bottom:8px;"></div>',
        '<div style="display:flex;gap:6px;margin-bottom:8px;">',
        '<button id="mt-gemini-use-last" style="flex:1;background:#FF4444;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">Usar última</button>',
        '<button id="mt-gemini-pick" style="flex:1;background:#2b5f9c;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">Selecionar</button>',
        '</div>',
        '<div id="mt-gemini-assist-status" style="color:#888;">Aguardando imagem gerada.</div>',
      ].join('');

      const imageNumber = Number.isFinite(Number(job.index))
        ? Number(job.index) + 1
        : 1;
      panel.querySelector('#mt-gemini-assist-description').textContent =
        `Imagem ${imageNumber}: marque o resultado correto se a detecção automática não pegar.`;

      panel.addEventListener('click', event => event.stopPropagation());
      root.documentElement.appendChild(panel);

      panel.querySelector('#mt-gemini-use-last').addEventListener('click', () => {
        reportManualIntervention(job, 'last-button');
        const images = findGeneratedResultImages(getIgnoreImages());
        const candidate = images[images.length - 1];
        if (candidate) {
          setManualGeminiResultUrl(getImageSource(candidate), 'last-button');
        } else {
          panel.querySelector('#mt-gemini-assist-status').textContent =
            'Ainda não encontrei uma imagem candidata.';
        }
      });

      panel.querySelector('#mt-gemini-pick').addEventListener('click', () => {
        reportManualIntervention(job, 'select-button');
        const status = panel.querySelector('#mt-gemini-assist-status');
        status.textContent = 'Clique diretamente na imagem correta gerada pelo Gemini.';

        const selectableImages = domApi.findAllDeep(
          root.body || root.documentElement,
          element => String(element.tagName || '').toUpperCase() === 'IMG'
        );

        selectableImages.forEach(image => {
          if (!isManualSelectableImage(image, getIgnoreImages())) return;
          image.dataset.mtGeminiPickable = 'true';
          image.style.outline = '3px solid #FF4444';
          image.style.outlineOffset = '2px';
        });

        if (pageWindow.__mangaTranslatorManualPickHandler) {
          root.removeEventListener(
            'click',
            pageWindow.__mangaTranslatorManualPickHandler,
            true
          );
        }

        pageWindow.__mangaTranslatorManualPickHandler = event => {
          const path = typeof event.composedPath === 'function'
            ? event.composedPath()
            : [];
          const image =
            path.find(node => String(node?.tagName || '').toUpperCase() === 'IMG') ||
            event.target?.closest?.('img');
          if (!image || !isManualSelectableImage(image, getIgnoreImages())) return;

          event.preventDefault();
          event.stopPropagation();
          setManualGeminiResultUrl(getImageSource(image), 'image-click');

          root.removeEventListener(
            'click',
            pageWindow.__mangaTranslatorManualPickHandler,
            true
          );
          pageWindow.__mangaTranslatorManualPickHandler = null;

          domApi.findAllDeep(
            root.body || root.documentElement,
            element => element?.getAttribute?.('data-mt-gemini-pickable') === 'true'
          ).forEach(candidate => {
            candidate.style.outline = '';
            candidate.style.outlineOffset = '';
            candidate.removeAttribute('data-mt-gemini-pickable');
          });
        };

        root.addEventListener(
          'click',
          pageWindow.__mangaTranslatorManualPickHandler,
          true
        );
      });

      return panel;
    }

    function setPromptInEditor(currentEditable, currentEditor, actualPrompt) {
      if (!currentEditable) return false;

      const prompt = String(actualPrompt || '');
      const existing = String(currentEditable.textContent || '').trim();
      if (existing === prompt.trim()) return true;

      try { currentEditable.focus?.(); } catch (_e) {}
      if (currentEditor && currentEditor !== currentEditable) {
        try { currentEditor.focus?.(); } catch (_e) {}
      }

      const FocusEventImpl = scope.FocusEvent || scope.Event;
      try {
        currentEditable.dispatchEvent(new FocusEventImpl('focus', {
          bubbles: true,
          composed: true,
        }));
        currentEditable.dispatchEvent(new FocusEventImpl('focusin', {
          bubbles: true,
          composed: true,
        }));
      } catch (_e) {}

      const quill = currentEditable.__quill ||
        currentEditor?.__quill ||
        (pageWindow.Quill &&
          typeof pageWindow.Quill.find === 'function' &&
          (pageWindow.Quill.find(currentEditable) || pageWindow.Quill.find(currentEditor)));

      if (quill) {
        try {
          if (typeof quill.setText === 'function') quill.setText(prompt, 'user');
          if (typeof quill.update === 'function') quill.update('user');
        } catch (_e) {}
      }

      const paragraph = root.createElement('p');
      paragraph.textContent = prompt;
      if (typeof currentEditable.replaceChildren === 'function') {
        currentEditable.replaceChildren(paragraph);
      } else {
        while (currentEditable.firstChild) {
          currentEditable.removeChild(currentEditable.firstChild);
        }
        currentEditable.appendChild(paragraph);
      }

      const InputEventImpl = scope.InputEvent || scope.Event;
      try {
        currentEditable.dispatchEvent(new InputEventImpl('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: prompt,
        }));
        currentEditable.dispatchEvent(new InputEventImpl('input', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: prompt,
        }));
        currentEditable.dispatchEvent(new scope.Event('input', {
          bubbles: true,
          composed: true,
        }));
        currentEditable.dispatchEvent(new scope.Event('change', {
          bubbles: true,
          composed: true,
        }));
      } catch (_e) {}

      if (currentEditor && 'value' in currentEditor) {
        try { currentEditor.value = prompt; } catch (_e) {}
        try {
          currentEditor.dispatchEvent(new scope.Event('input', {
            bubbles: true,
            composed: true,
          }));
        } catch (_e) {}
      }

      return String(currentEditable.textContent || '').trim().length >= 5;
    }

    async function shouldKeepConversationForDebug(delivery, executionMode) {
      if (
        executionMode !== 'background_delete' ||
        !delivery ||
        delivery.action !== 'GEMINI_ERROR'
      ) {
        return false;
      }
      const data = await storageGet(['debugMode']);
      return data.debugMode === true;
    }

    function sendRuntimeMessage(message) {
      return new Promise(resolve => {
        try {
          runtime.sendMessage(message, response => {
            if (runtime.lastError) resolve(null);
            else resolve(response || null);
          });
        } catch (_e) {
          resolve(null);
        }
      });
    }

    async function requestImageData(job) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await sendRuntimeMessage({
          action: 'REQUEST_IMAGE_DATA',
          mangaTabId: job.mangaTabId,
          index: job.index,
        });
        if (response?.srcData) return response;
        await sleep(1000);
      }
      return null;
    }

    function assertStage(condition, errorMessage, step, successMessage = '') {
      if (!condition) {
        const fullError = `[ERRO CRÍTICO - ETAPA ${step}] ${errorMessage}`;
        debugConsole('error', fullError);
        sendLog(
          'error',
          `TEST_FAIL_STEP_${step}`,
          errorMessage,
          { path: pageWindow.location.pathname }
        );
        throw new Error(fullError);
      }

      sendLog(
        'success',
        `TEST_PASS_STEP_${step}`,
        successMessage || `Etapa ${step} com sucesso`,
        { path: pageWindow.location.pathname }
      );
    }

    async function run(job) {
      if (!job) throw new Error('Job Gemini é obrigatório');

      setAntiThrottleMode('minimal');
      const myTabId = job.geminiTabId;
      let watchdogRefreshRequested = false;
      const recoveryResult = await deletionController.recoverPending({
        tabId: myTabId,
        sendDelivery: async delivery => {
          runtime.sendMessage(delivery);
        },
      });
      if (recoveryResult.handled) {
        return { status: 'recovery_handled', deleted: recoveryResult.deleted };
      }

      openKeepAlive();

      debugConsole('log', '[MangaTranslator Gemini] Job confirmado por claim:', {
        jobId: String(job.jobId || '').slice(0, 8),
        index: job.index,
        geminiTabId: myTabId,
      });

      let scrollInterval = null;
      let executionMode = job.executionMode || null;

      const startScrollAssist = () => {
        scrollInterval = setIntervalFn(() => {
          try {
            pageWindow.scrollTo(0, root.body.scrollHeight);
            const images = root.querySelectorAll('img');
            if (images.length > 0) {
              images[images.length - 1].scrollIntoView({
                behavior: 'smooth',
                block: 'center',
              });
            }
          } catch (_e) {}
        }, 2000);
      };

      const stopScrollAssist = () => {
        if (scrollInterval !== null) {
          try { clearIntervalFn(scrollInterval); } catch (_e) {}
          scrollInterval = null;
        }
      };

      async function deliverWithSecureDeletion(delivery, shouldDeleteConversation) {
        if (executionMode !== 'background_delete') {
          if (shouldDeleteConversation) {
            deletionController.deleteCurrentConversation().catch(() => {});
          }
          runtime.sendMessage(delivery);
          return true;
        }

        if (await shouldKeepConversationForDebug(delivery, executionMode)) {
          sendLog(
            'info',
            'DEBUG_KEEP_CONVERSATION',
            'Modo debug: conversa preservada após erro de extração.',
            {}
          );
          runtime.sendMessage(delivery);
          return true;
        }

        stopScrollAssist();
        const deletion = await deletionController.deleteOrScheduleRecovery({
          tabId: myTabId,
          delivery,
        });

        if (deletion.deleted) {
          runtime.sendMessage(delivery);
          return true;
        }
        return false;
      }

      startScrollAssist();

      try {
        reportProgress('📡 OBTENDO IMAGEM...', job.mangaTabId);
        debugConsole(
          'log',
          '[MangaTranslator Gemini] Obtendo imagem da aba do mangá...',
          { index: job.index }
        );
        sendLog('info', 'GEMINI_STEP_1', 'Obtendo imagem', { index: job.index });

        const imageResponse = await requestImageData(job);
        assertStage(
          imageResponse && imageResponse.srcData,
          'Sem resposta da aba do mangá.',
          1,
          'Resposta inicial carregada com sucesso.'
        );
        assertStage(
          String(imageResponse.srcData).startsWith('data:image/'),
          'Os dados não são imagem válida.',
          1,
          'Base64 validada.'
        );
        job.srcData = imageResponse.srcData;

        reportProgress('⏳ AGUARDANDO INTERFACE...', job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Aguardando interface do Gemini...');

        const editor = await waitForElement(
          'rich-textarea, .ql-editor, [contenteditable="true"]',
          20_000
        );
        assertStage(editor !== null, 'Editor não carregou.', 2, 'Editor alvo detectado');

        try {
          editor.focus?.({ preventScroll: true });
          const FocusEventImpl = scope.FocusEvent || scope.Event;
          editor.dispatchEvent(new FocusEventImpl('focus', {
            bubbles: true,
            composed: true,
          }));
          editor.dispatchEvent(new FocusEventImpl('focusin', {
            bubbles: true,
            composed: true,
          }));
          pageWindow.dispatchEvent(new scope.Event('focus'));
        } catch (_e) {}

        if (!executionMode) {
          const data = await storageGet(['geminiExecutionMode']);
          executionMode = data.geminiExecutionMode || 'temp_chat';
        }

        const steadyAntiThrottleMode = getAntiThrottleModeForExecutionMode(executionMode);
        setAntiThrottleMode(steadyAntiThrottleMode);

        let tempChatResult = { success: false };
        if (executionMode === 'temp_chat') {
          reportProgress('🔒 ATIVANDO CONVERSA TEMPORÁRIA...', job.mangaTabId);
          debugConsole('log', '[MangaTranslator Gemini] Ativando conversa temporária...');
          sendLog(
            'info',
            'GEMINI_STEP_TEMP_CHAT',
            'Ativando conversa temporária no Gemini',
            {}
          );

          try {
            const tempStatus = await temporaryChatApi.ensureActive({
              root,
              timeoutMs: 12_000,
              sleep,
            });

            tempChatResult = {
              success:
                tempStatus.status === 'already_active' ||
                tempStatus.status === 'activated_verified',
              alreadyActive: tempStatus.status === 'already_active',
              activated: tempStatus.status === 'activated_verified',
              notFound: tempStatus.status === 'unavailable',
              verificationFailed: tempStatus.status === 'verification_failed',
              status: tempStatus.status,
            };

            sendLog(
              'info',
              'GEMINI_TEMP_CHAT_STATUS',
              'Status da conversa temporária',
              { status: tempStatus.status }
            );

            if (
              tempStatus.status === 'activated_verified' ||
              tempStatus.status === 'already_active'
            ) {
              await sleep(1500);
            } else if (tempStatus.status === 'verification_failed') {
              sendLog(
                'warn',
                'GEMINI_TEMP_CHAT_VERIFY_FAILED',
                'Clique não confirmou ativação da conversa temporária',
                {}
              );
            }
          } catch (error) {
            debugConsole(
              'warn',
              '[MangaTranslator Gemini] Aviso ao ativar conversa temporária:',
              error && error.message
            );
            sendLog(
              'warn',
              'GEMINI_TEMP_CHAT_ERR',
              `Aviso ao ativar conversa temporária: ${error.message}`,
              {}
            );
          }
        }

        const liveEditor =
          root.querySelector('rich-textarea, .ql-editor, [contenteditable="true"]') ||
          editor;
        const liveEditable = domApi.getEditableElement(liveEditor) || liveEditor;

        const editorIsDisabled = [liveEditor, liveEditable].some(element =>
          element && (
            element.disabled === true ||
            element.getAttribute?.('aria-disabled') === 'true' ||
            element.getAttribute?.('contenteditable') === 'false'
          )
        );
        assertStage(!editorIsDisabled, 'Editor do Gemini está desabilitado.', 2);

        reportProgress('📎 ANEXANDO IMAGEM...', job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Anexando imagem...');
        const file = dataURLtoFile(job.srcData, 'manga_page.png');
        assertStage(file.size > 0, 'Imagem gerada vazia.', 3, 'PNG verificado no buffer');

        const runAttachmentAttempt = async ({
          editorElement,
          editorRootElement,
          timeoutMs,
          maxDispatches,
          phase,
        }) => {
          sendLog(
            'info',
            'GEMINI_ATTACHMENT_ATTEMPT',
            'Tentativa de attachment iniciada',
            { executionMode, phase, maxDispatches }
          );

          const result = await attachmentApi.attachFile({
            file,
            editor: editorElement,
            editorRoot: editorRootElement,
            root,
            timeoutMs,
            retryAfterMs: 2500,
            maxDispatches,
            sleep,
          });

          sendLog(
            result.confirmed ? 'success' : 'warn',
            result.confirmed ? 'GEMINI_ATTACHMENT_CONFIRMED' : 'GEMINI_ATTACHMENT_UNCONFIRMED',
            result.confirmed
              ? 'Attachment confirmado por evidência de DOM do composer'
              : 'Attachment ainda não confirmado',
            {
              executionMode,
              phase,
              attempted: result.attempted,
              attempts: result.attempts,
              signalObserved: result.signalObserved,
              methods: result.methodsAttempted,
              evidenceType: result.evidence?.type || null,
            }
          );
          return { ...result, phase };
        };

        let attachmentResult = await runAttachmentAttempt({
          editorElement: liveEditable,
          editorRootElement: liveEditor,
          timeoutMs: 8_000,
          maxDispatches: 3,
          phase: 'background',
        });

        if (!attachmentResult.confirmed) {
          sendLog(
            'warn',
            'GEMINI_ATTACHMENT_RECOVERY',
            'Attachment não confirmou em background; ativando contexto Gemini temporariamente',
            { executionMode, signalObserved: attachmentResult.signalObserved }
          );

          const activation = await sendRuntimeMessage({
            action: 'FORCE_ATTACHMENT_ACTIVATION',
            geminiTabId: myTabId,
            mangaTabId: job.mangaTabId,
            windowId: job.windowId,
            executionMode,
          });

          try {
            if (activation?.ok !== false) {
              await sleep(350);
              const recoveredRoot =
                root.querySelector('rich-textarea, .ql-editor, [contenteditable="true"]') ||
                liveEditor;
              const recoveredEditor = domApi.getEditableElement(recoveredRoot) || recoveredRoot;

              attachmentResult = await runAttachmentAttempt({
                editorElement: recoveredEditor,
                editorRootElement: recoveredRoot,
                timeoutMs: 12_000,
                maxDispatches: 3,
                phase: 'foreground_recovery',
              });
            } else {
              sendLog(
                'warn',
                'GEMINI_ATTACHMENT_ACTIVATION_FAILED',
                'Não foi possível ativar o contexto Gemini para recovery de attachment',
                { executionMode, reason: activation?.reason || activation?.error || null }
              );
            }
          } finally {
            await sendRuntimeMessage({
              action: 'RESTORE_ATTACHMENT_ACTIVATION',
              geminiTabId: myTabId,
              mangaTabId: job.mangaTabId,
              windowId: job.windowId,
              executionMode,
            });
          }
        }

        if (!attachmentResult.confirmed) {
          const error = new Error('GEMINI_ATTACHMENT_NOT_CONFIRMED');
          error.code = 'GEMINI_ATTACHMENT_NOT_CONFIRMED';

          sendLog(
            'error',
            'GEMINI_ATTACHMENT_NOT_CONFIRMED',
            'Attachment não pôde ser confirmado; submit bloqueado',
            {
              executionMode,
              attempted: attachmentResult.attempted,
              attempts: attachmentResult.attempts,
              signalObserved: attachmentResult.signalObserved,
              methods: attachmentResult.methodsAttempted,
            }
          );
          throw error;
        }

        const attachmentEvidence = attachmentResult.evidence || {};
        debugConsole(
          'log',
          '[MangaTranslator Gemini] Attachment confirmado:',
          { type: attachmentEvidence.type, selector: attachmentEvidence.selector }
        );
        sendLog(
          'success',
          'GEMINI_STEP_3_OK',
          'Attachment confirmado; pipeline liberado para submit',
          {
            executionMode,
            type: attachmentEvidence.type,
            selector: attachmentEvidence.selector,
            phase: attachmentResult.phase || 'unknown',
          }
        );
        await sleep(500);

        reportProgress('📤 ENVIANDO PROMPT...', job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Injetando prompt e enviando...');

        const fallbackPrompt =
          'Crie uma imagem traduzindo todas as falas desta imagem para o Português. Mantenha o sentido original e apenas altere ou modifique o texto na imagem.';
        const actualPrompt =
          job.prompt && String(job.prompt).trim().length > 0
            ? job.prompt
            : fallbackPrompt;

        if (actualPrompt === fallbackPrompt && !job.prompt?.trim?.()) {
          sendLog(
            'error',
            'PROMPT_FALLBACK',
            'Prompt falhou ou está vazio. Usando emergência!',
            { fallbackLength: fallbackPrompt.length }
          );
        }

        const activeEditor =
          root.querySelector('rich-textarea, .ql-editor, [contenteditable="true"]') ||
          liveEditor;
        const activeEditable =
          root.querySelector(
            'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]'
          ) ||
          domApi.getEditableElement(activeEditor) ||
          liveEditable;

        const CustomEventImpl = scope.CustomEvent || pageWindow.CustomEvent;
        pageWindow.dispatchEvent(new CustomEventImpl(
          'MANGA_TRANSLATOR_SET_PROMPT',
          { detail: { prompt: actualPrompt } }
        ));
        await sleep(200);

        setPromptInEditor(activeEditable, activeEditor, actualPrompt);

        const promptLength = String(activeEditable.textContent || '').trim().length;
        assertStage(
          promptLength >= 5,
          `O prompt não foi inserido. Comprimento: ${promptLength}`,
          4,
          'Prompt injetado com sucesso.'
        );
        sendLog(
          'success',
          'PROMPT_INJECTED',
          'Prompt confirmado no DOM',
          { promptLen: promptLength }
        );
        await sleep(1000);

        const ignoreImages = new Set(
          Array.from(root.querySelectorAll('img'))
            .map(image => getImageSource(image))
            .filter(Boolean)
        );
        const inputImageElements = new Set();
        if (attachmentResult.evidence?.img) {
          inputImageElements.add(attachmentResult.evidence.img);
        }

        activeObserver = observerApi.createGeminiObserver({
          jobId: job.jobId,
          root,
          editor: activeEditable,
          getEditor: () =>
            root.querySelector(
              'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]'
            ) || activeEditable,
          ignoreImages,
          inputImageElements,
          onStateChange: (type, detail) => {
            if (type === 'generation_started') {
              sendLog(
                'info',
                'GEMINI_GENERATION_ACTIVE',
                'Geração observada na UI',
                { executionMode, reason: detail && detail.reason }
              );

              if (!watchdogRefreshRequested) {
                watchdogRefreshRequested = true;
                sendLog(
                  'info',
                  'GEMINI_WATCHDOG_REFRESH_REQUESTED',
                  'Reiniciando o prazo do watchdog a partir do início real da geração',
                  { executionMode }
                );
                sendRuntimeMessage({
                  action: 'REFRESH_JOB_WATCHDOG',
                  geminiTabId: myTabId,
                  mangaTabId: job.mangaTabId,
                  index: job.index,
                  jobId: job.jobId,
                  batchId: job.batchId,
                }).then(response => {
                  const ok = response && response.ok !== false;
                  sendLog(
                    ok ? 'success' : 'warn',
                    ok ? 'GEMINI_WATCHDOG_REFRESH_CONFIRMED' : 'GEMINI_WATCHDOG_REFRESH_FAILED',
                    ok
                      ? 'Watchdog reiniciado após o início da geração'
                      : 'Não foi possível reiniciar o watchdog após o início da geração',
                    { executionMode }
                  );
                }).catch(() => {
                  sendLog(
                    'warn',
                    'GEMINI_WATCHDOG_REFRESH_FAILED',
                    'Falha ao solicitar reinício do watchdog',
                    { executionMode }
                  );
                });
              }
            } else if (type === 'model_turn_acquired') {
              sendLog(
                'info',
                'GEMINI_MODEL_TURN_ACQUIRED',
                'Nova resposta estrita do modelo adquiriu ownership do job',
                { executionMode, responseIndex: detail && detail.responseIndex }
              );
            } else if (type === 'model_turn_fallback_acquired') {
              sendLog(
                'warn',
                'GEMINI_MODEL_TURN_FALLBACK',
                'Resultado detectado por fallback seguro porque o wrapper estrito do Gemini mudou.',
                {
                  executionMode,
                  reason: detail && detail.reason,
                  urlKind: detail && detail.urlKind,
                }
              );
            } else if (type === 'result_dom_seen') {
              sendLog(
                'info',
                'GEMINI_RESULT_DOM_SEEN',
                'Imagem apareceu dentro do model turn observado',
                { executionMode, imageCount: detail && detail.imageCount }
              );
            } else if (type === 'result_image_seen') {
              sendLog(
                'info',
                'GEMINI_RESULT_IMG_SEEN',
                'Fonte de imagem observada no model turn',
                {
                  executionMode,
                  urlKind: detail && detail.urlKind,
                  strongUrl: Boolean(detail && detail.strongUrl),
                }
              );
            } else if (type === 'result_candidate') {
              sendLog(
                'success',
                'GEMINI_RESULT_OWNER_VALID',
                'Imagem candidata pertence ao model turn atual',
                {
                  executionMode,
                  urlKind: detail && detail.urlKind,
                  strongUrl: Boolean(detail && detail.strongUrl),
                }
              );
            } else if (
              type === 'result_image' &&
              Number(detail?.elapsedAfterSubmitMs) >= 0 &&
              Number(detail.elapsedAfterSubmitMs) < 750
            ) {
              sendLog(
                'warn',
                'GEMINI_RESULT_FAST',
                'Resultado apareceu muito rápido após submit; ownership do model turn foi exigido',
                { executionMode, elapsedAfterSubmitMs: detail.elapsedAfterSubmitMs }
              );
            }
          },
        }).start();

        pageWindow.__mangaTranslatorActiveGeminiObserver = activeObserver;
        sendLog(
          'info',
          'GEMINI_OBSERVER_READY',
          'Observer instalado antes do submit',
          { jobIdPrefix: String(job.jobId || '').slice(0, 8) }
        );

        let submission;
        try {
          submission = await editorApi.submitWithConfirmation({
            observer: activeObserver,
            getEditor: () =>
              root.querySelector(
                'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]'
              ) || activeEditable,
            getSendButton: () => domApi.findSendButton(root.body),
            maxAttempts: 2,
            confirmationTimeoutMs: 5000,
            sleep,
            onAttempt: attempt => {
              sendLog(
                'info',
                'GEMINI_SUBMIT_ATTEMPT',
                'Tentativa de submit iniciada',
                { executionMode, attempt }
              );

              if (attempt === 2) {
                setAntiThrottleMode('legacy');
                runtime.sendMessage({
                  action: 'FORCE_SEND_ACTIVATION',
                  geminiTabId: myTabId,
                  mangaTabId: job.mangaTabId,
                  windowId: job.windowId,
                  executionMode: job.executionMode,
                }, () => {
                  if (runtime.lastError) {}
                });
              }
            },
            mainWorldFallback: async () => {
              pageWindow.dispatchEvent(new CustomEventImpl(
                'MANGA_TRANSLATOR_TRIGGER_SEND'
              ));
              sendLog(
                'warn',
                'GEMINI_SEND_FALLBACK',
                'Fallback MAIN-world tentado; aguardando confirmação observável',
                {}
              );
              return true;
            },
          });
        } catch (submitError) {
          if (submitError?.code === 'GEMINI_SUBMISSION_NOT_CONFIRMED') {
            sendLog(
              'error',
              'GEMINI_SUBMISSION_NOT_CONFIRMED',
              'Nenhuma transição da UI confirmou o envio após duas tentativas',
              {}
            );
            const error = new Error('GEMINI_SUBMISSION_NOT_CONFIRMED');
            error.code = 'GEMINI_SUBMISSION_NOT_CONFIRMED';
            throw error;
          }
          throw submitError;
        }

        setAntiThrottleMode(steadyAntiThrottleMode);
        sendLog(
          'success',
          'GEMINI_SEND_SUCCESS',
          'Envio confirmado por transição observável da UI',
          { executionMode, attempt: submission.attempt, reason: submission.reason }
        );
        debugConsole(
          'log',
          '[MangaTranslator Gemini] Envio confirmado pelo Observer V3.',
          { attempt: submission.attempt, reason: submission.reason }
        );
        assertStage(
          submission && submission.confirmed,
          'Envio não foi confirmado pela interface.',
          4,
          'Submit confirmado pela UI'
        );

        reportProgress('🧠 GEMINI PROCESSANDO...', job.mangaTabId);
        createGeminiManualPanel(job, () => ignoreImages);

        const shouldDeleteConversation =
          executionMode === 'minimized_window' ||
          executionMode === 'background_delete' ||
          (
            executionMode === 'temp_chat' &&
            tempChatResult.notFound &&
            !tempChatResult.alreadyActive
          );

        const configuredTimeout = Number(scope.__MT_GEMINI_GENERATION_TIMEOUT_MS__);
        const waitTimeoutMs =
          Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : 4 * 60 * 1000;

        const waitStartedAt = Date.now();
        const progressTimer = setIntervalFn(() => {
          const elapsedSeconds = Math.floor((Date.now() - waitStartedAt) / 1000);
          reportProgress(
            `🧠 GEMINI PROCESSANDO (${elapsedSeconds}s)...`,
            job.mangaTabId
          );
        }, 5000);

        let resultUrl = null;
        let resultImageElement = null;

        try {
          const observedResult = await activeObserver.waitForResult(waitTimeoutMs);
          resultUrl = observedResult && observedResult.url;
          resultImageElement = observedResult && observedResult.image;
        } catch (waitError) {
          if (waitError?.code === 'GEMINI_UI_ERROR') {
            sendLog(
              'error',
              'GEMINI_ERROR',
              'Erro visível da UI detectado pelo Observer V3',
              { messageLength: String(waitError.message || '').length }
            );
            await deliverWithSecureDeletion({
              action: 'GEMINI_ERROR',
              mangaTabId: job.mangaTabId,
              index: job.index,
              error:
                `Retornou erro interface: ${String(waitError.message || 'Erro da interface do Gemini')}`,
              jobId: job.jobId,
              batchId: job.batchId,
            }, shouldDeleteConversation);
            return { status: 'ui_error' };
          }

          if (waitError?.code === 'GEMINI_RESULT_TIMEOUT') {
            sendLog(
              'error',
              'GEMINI_TIMEOUT',
              'Timeout de geração aguardando Observer V3',
              {}
            );
            await deliverWithSecureDeletion({
              action: 'GEMINI_ERROR',
              mangaTabId: job.mangaTabId,
              index: job.index,
              error: 'Tempo limite (4 min)',
              jobId: job.jobId,
              batchId: job.batchId,
            }, shouldDeleteConversation);
            return { status: 'result_timeout' };
          }

          throw waitError;
        } finally {
          clearIntervalFn(progressTimer);
        }

        assertStage(
          resultUrl &&
            (
              resultUrl.startsWith('http') ||
              resultUrl.startsWith('blob') ||
              resultUrl.startsWith('data:image/')
            ),
          'URL Imagem inválida',
          5,
          'Mídia extraída blob'
        );

        sendLog(
          'info',
          'GEMINI_RESULT_CANDIDATE',
          'Imagem candidata com ownership de model turn detectada',
          { executionMode, ...getUrlLogMetadata(resultUrl) }
        );
        reportProgress('📥 EXTRAINDO IMAGEM...', job.mangaTabId);

        if (
          resultUrl.includes('googleusercontent.com') &&
          /=s\d+/.test(resultUrl)
        ) {
          resultUrl = resultUrl.replace(/=s\d+[^?#]*/, '=s0');
        }

        sendLog(
          'info',
          'GEMINI_RESULT_EXTRACTION_START',
          'Iniciando extração da imagem gerada',
          { executionMode, ...getUrlLogMetadata(resultUrl) }
        );

        let extraction;
        try {
          extraction = await resultExtractor.extractOrAuxiliaryFallback({
            resultImageElement,
            resultUrl,
            executionMode,
            maxAttempts: 4,
            retryDelayMs: 1000,
            onAuxiliaryFallback: async ({ url }) => {
              return deliverWithSecureDeletion({
                action: 'GEMINI_RESULT_URL',
                mangaTabId: job.mangaTabId,
                index: job.index,
                url,
                jobId: job.jobId,
                batchId: job.batchId,
              }, shouldDeleteConversation);
            },
          });
          sendLog(
            'success',
            'GEMINI_RESULT_EXTRACTION_OK',
            'Extração da imagem gerada concluída',
            { executionMode, kind: extraction.kind }
          );
        } catch (extractionError) {
          sendLog(
            'error',
            'GEMINI_RESULT_EXTRACTION_FAILED',
            'Todas as rotas de extração da imagem falharam',
            {
              executionMode,
              errorName: extractionError && extractionError.name
                ? extractionError.name
                : 'Error',
            }
          );
          throw extractionError;
        }

        if (extraction.kind === 'extracted' && extraction.dataUrl) {
          if (sameImagePayload(job.srcData, extraction.dataUrl)) {
            const error = new Error('GEMINI_RESULT_MATCHES_INPUT');
            error.code = 'GEMINI_RESULT_MATCHES_INPUT';
            sendLog(
              'error',
              'GEMINI_RESULT_MATCHES_INPUT',
              'Resultado rejeitado: bytes são idênticos à imagem de entrada',
              { executionMode }
            );
            throw error;
          }

          sendLog(
            'success',
            'GEMINI_IMG_FOUND',
            'Imagem gerada validada e diferente do input',
            { executionMode, ...getUrlLogMetadata(resultUrl) }
          );

          await deliverWithSecureDeletion({
            action: 'GEMINI_IMAGE_EXTRACTED',
            mangaTabId: job.mangaTabId,
            index: job.index,
            src: extraction.dataUrl,
            jobId: job.jobId,
            batchId: job.batchId,
          }, shouldDeleteConversation);
        }

        return {
          status: extraction.kind === 'extracted'
            ? 'delivered_extracted'
            : 'delivered_auxiliary',
        };
      } catch (error) {
        sendLog(
          'error',
          error?.code || 'GEMINI_JOB_ERROR',
          'Job Gemini interrompido',
          { executionMode, message: error?.message || String(error) }
        );
        runtime.sendMessage({
          action: 'GEMINI_ERROR',
          mangaTabId: job.mangaTabId,
          index: job.index,
          error: error.message,
          jobId: job.jobId,
          batchId: job.batchId,
        });
        return { status: 'error', error };
      } finally {
        setAntiThrottleMode('minimal');

        if (activeObserver) {
          try { activeObserver.stop(); } catch (_e) {}
          activeObserver = null;
        }

        if (pageWindow.__mangaTranslatorActiveGeminiObserver) {
          delete pageWindow.__mangaTranslatorActiveGeminiObserver;
        }

        stopScrollAssist();
        closeKeepAlive();
        removeGeminiManualPanel();

        if (pageWindow.__mangaTranslatorManualPickHandler) {
          root.removeEventListener(
            'click',
            pageWindow.__mangaTranslatorManualPickHandler,
            true
          );
          delete pageWindow.__mangaTranslatorManualPickHandler;
        }

        root.querySelectorAll('img').forEach(image => {
          if (image.style.outline?.includes('#FF4444')) {
            image.style.outline = '';
            image.style.outlineOffset = '';
          }
        });
      }
    }

    function getActiveObserver() {
      return activeObserver;
    }

    return {
      run,
      dataURLtoFile,
      waitForElement,
      isStrongGeneratedImageUrl,
      isLikelyGeneratedImage,
      isManualSelectableImage,
      findGeneratedResultImages,
      setManualGeminiResultUrl,
      removeGeminiManualPanel,
      createGeminiManualPanel,
      reportManualIntervention,
      setPromptInEditor,
      shouldKeepConversationForDebug,
      requestImageData,
      sendRuntimeMessage,
      dataUrlPayload,
      sameImagePayload,
      getAntiThrottleModeForExecutionMode,
      setAntiThrottleMode,
      getActiveObserver,
    };
  }

  const api = { createGeminiJobRunner };
  scope.MangaTranslatorGeminiJobRunner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
