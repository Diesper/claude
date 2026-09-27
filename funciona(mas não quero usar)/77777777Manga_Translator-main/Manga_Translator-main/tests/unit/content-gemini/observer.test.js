'use strict';

const path = require('path');

const SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');
const OBSERVER_PATH = path.resolve(__dirname, '../../../extension/gemini/observer.js');

function loadObserver() {
  let observerApi;
  jest.isolateModules(() => {
    require(SELECTORS_PATH);
    require(DOM_PATH);
    observerApi = require(OBSERVER_PATH);
  });
  return observerApi;
}

function visibleRect(element, width = 120, height = 40) {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() { return this; },
  });
}

function addStop({ hidden = false } = {}) {
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Stop generating');
  visibleRect(button, 36, 36);
  if (hidden) button.style.display = 'none';
  document.body.appendChild(button);
  return button;
}

function addResponse() {
  const response = document.createElement('model-response');
  document.body.appendChild(response);
  return response;
}

function addResultImage(container, src = 'https://cdn.example/result.png') {
  const image = document.createElement('img');
  image.src = src;
  Object.defineProperty(image, 'naturalWidth', { value: 1024, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: 1536, configurable: true });
  Object.defineProperty(image, 'complete', { value: true, configurable: true });
  container.appendChild(image);
  return image;
}

function addError(text, { hidden = false } = {}) {
  const alert = document.createElement('div');
  alert.setAttribute('role', 'alert');
  alert.textContent = text;
  visibleRect(alert, 300, 50);
  if (hidden) alert.style.display = 'none';
  document.body.appendChild(alert);
  return alert;
}

function flushMutations() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('gemini/observer.js — Observer V3', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete window.__mtGeminiObservers;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.__mtGeminiObservers;
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('OBS-01: Stop presente mas display:none não ativa geração', () => {
    addStop({ hidden: true });
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-01' }).start();

    expect(observer.getState().generationActiveObserved).toBe(false);
    expect(observer.getState().submissionConfirmed).toBe(false);
    observer.stop();
  });

  test('OBS-02: Stop visível ativa geração e confirma submission', () => {
    addStop();
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-02' }).start();

    expect(observer.getState().generationActiveObserved).toBe(true);
    expect(observer.getState().submissionConfirmed).toBe(true);
    expect(observer.getState().submissionReason).toBe('stop_visible');
    observer.stop();
  });

  test('OBS-03: novo response container é adquirido pelo job atual', () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-03' }).start();
    const response = addResponse();

    observer.inspect();

    expect(observer.getState().responseContainer).toBe(response);
    expect(observer.getState().submissionConfirmed).toBe(true);
    expect(observer.getState().submissionReason).toBe('response_created');
    observer.stop();
  });

  test('OBS-04: alteração em resposta antiga não transfere ownership', () => {
    const oldResponse = addResponse();
    oldResponse.textContent = 'resposta antiga';

    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-04' }).start();

    oldResponse.textContent = 'resposta antiga alterada';
    observer.inspect();

    expect(observer.getState().responseContainer).toBeNull();
    expect(observer.getState().submissionConfirmed).toBe(false);
    observer.stop();
  });

  test('OBS-05: imagem que já existia no baseline é ignorada mesmo se reaparecer', () => {
    const baseline = document.createElement('img');
    baseline.src = 'https://cdn.example/already-there.png';
    document.body.appendChild(baseline);

    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-05' }).start();

    const response = addResponse();
    addResultImage(response, 'https://cdn.example/already-there.png');
    observer.inspect();

    expect(observer.getState().responseContainer).toBe(response);
    expect(observer.getState().resultUrl).toBeNull();
    expect(observer.getState().done).toBe(false);
    observer.stop();
  });

  test('OBS-06: nova imagem dentro do novo response produz resultado', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-06' }).start();
    const pending = observer.waitForResult(1000);

    const response = addResponse();
    const image = addResultImage(response, 'https://cdn.example/new-result.png');
    observer.inspect();

    await expect(pending).resolves.toEqual({
      image,
      url: 'https://cdn.example/new-result.png',
    });
    expect(observer.getState().done).toBe(true);
    observer.stop();
  });

  test('OBS-07: erro oculto é ignorado', () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-07' }).start();

    addError('Falha invisível', { hidden: true });
    observer.inspect();

    expect(observer.getState().error).toBeNull();
    expect(observer.getState().done).toBe(false);
    observer.stop();
  });

  test('OBS-08: erro visível novo encerra o observer logicamente', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-08' }).start();
    const pending = observer.waitForResult(1000);

    addError('Gemini indisponível agora');
    observer.inspect();

    await expect(pending).rejects.toMatchObject({
      code: 'GEMINI_UI_ERROR',
      message: 'Gemini indisponível agora',
    });
    expect(observer.getState().error).toBe('Gemini indisponível agora');
    expect(observer.getState().done).toBe(true);
    observer.stop();
  });

  test('OBS-09: cleanup é idempotente e remove observers/timers/registry', () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-09' }).start();

    expect(window.__mtGeminiObservers['obs-09']).toBe(observer);
    expect(observer.stop()).toBe(true);
    expect(observer.stop()).toBe(false);

    const state = observer.getState();
    expect(state.cleanedUp).toBe(true);
    expect(state.observer).toBeNull();
    expect(state.responseObserver).toBeNull();
    expect(state.timers.size).toBe(0);
    expect(window.__mtGeminiObservers['obs-09']).toBeUndefined();
  });

  test('OBS-10: mutations depois do cleanup não emitem resultado', async () => {
    const onStateChange = jest.fn();
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({
      jobId: 'obs-10',
      onStateChange,
    }).start();

    observer.stop();
    const response = addResponse();
    addResultImage(response);
    await flushMutations();

    expect(onStateChange.mock.calls.map(call => call[0])).not.toContain('result_image');
    expect(observer.getState().resultUrl).toBeNull();
  });

  test('OBS-11: observer instalado antes do submit captura resposta imediata', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-11' }).start();
    const pending = observer.waitForResult(1000);

    const response = addResponse();
    const image = addResultImage(response, 'https://cdn.example/instant.png');

    await flushMutations();

    await expect(pending).resolves.toEqual({
      image,
      url: 'https://cdn.example/instant.png',
    });
    observer.stop();
  });

  test('OBS-12: ausência de Stop sem geração ativa não produz done falso', () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-12' }).start();

    const response = addResponse();
    response.textContent = 'preparando';
    observer.inspect();

    expect(observer.getState().responseContainer).toBe(response);
    expect(observer.getState().generationActiveObserved).toBe(false);
    expect(observer.getState().generationFinished).toBe(false);
    expect(observer.getState().done).toBe(false);
    observer.stop();
  });

  test('OBS-13: send disabled no baseline não confirma submit; transição enabled -> disabled confirma', () => {
    const send = document.createElement('button');
    send.setAttribute('aria-label', 'Send message');
    send.disabled = true;
    visibleRect(send, 36, 36);
    document.body.appendChild(send);

    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-13' }).start();

    expect(observer.getState().submissionConfirmed).toBe(false);

    send.disabled = false;
    observer.inspect();
    expect(observer.getState().submissionConfirmed).toBe(false);

    send.disabled = true;
    observer.inspect();

    expect(observer.getState().submissionConfirmed).toBe(true);
    expect(observer.getState().submissionReason).toBe('send_busy');
    observer.stop();
  });

  test('coalescing: várias mutations no mesmo turno agendam uma única inspeção', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'obs-coalesce' }).start();
    const before = observer.getState().inspectCount;

    const node = document.createElement('div');
    document.body.appendChild(node);
    node.setAttribute('data-a', '1');
    node.setAttribute('data-b', '2');
    node.textContent = 'mudança';

    await flushMutations();

    expect(observer.getState().inspectCount).toBeLessThanOrEqual(before + 2);
    observer.stop();
  });
  test('OBS-14: imagem nova fora de model turn é ignorada', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'strict-result-ownership' }).start();

    const result = document.createElement('img');
    result.src = 'blob:https://gemini.google.com/not-a-model-result';
    Object.defineProperty(result, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(result, 'naturalHeight', { value: 1600, configurable: true });
    Object.defineProperty(result, 'complete', { value: true, configurable: true });
    document.body.appendChild(result);

    observer.inspect();
    await flushMutations();

    expect(observer.getState().resultUrl).toBeNull();
    expect(observer.getState().modelTurn).toBeNull();
    observer.stop();
  });

  test('PR6: seleção manual resolve a mesma Promise de resultado', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'manual-result' }).start();
    const pending = observer.waitForResult(1000);

    expect(observer.acceptResult(null, 'blob:https://gemini.google.com/manual-picked')).toBe(true);

    await expect(pending).resolves.toEqual({
      image: null,
      url: 'blob:https://gemini.google.com/manual-picked',
    });
    observer.stop();
  });


  test('OBS-15: clone da imagem de entrada em user turn, mesmo com nova blob URL, é ignorado', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'user-clone' }).start();

    const send = document.createElement('button');
    send.setAttribute('aria-label', 'Send message');
    visibleRect(send, 36, 36);
    document.body.appendChild(send);
    send.disabled = false;
    observer.inspect();
    send.disabled = true;
    observer.inspect();

    const userTurn = document.createElement('div');
    userTurn.setAttribute('data-message-author', 'user');
    const clone = document.createElement('img');
    clone.src = 'blob:https://gemini.google.com/reencoded-input';
    Object.defineProperty(clone, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(clone, 'naturalHeight', { value: 1600, configurable: true });
    Object.defineProperty(clone, 'complete', { value: true, configurable: true });
    userTurn.appendChild(clone);
    document.body.appendChild(userTurn);

    observer.inspect();
    expect(observer.getState().submissionConfirmed).toBe(true);
    expect(observer.getState().resultUrl).toBeNull();
    expect(observer.getState().modelTurn).toBeNull();
    observer.stop();
  });

  test('OBS-16: model turn estrito com resultado rápido continua sendo aceito', async () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'strict-fast-result' }).start();
    const pending = observer.waitForResult(1000);

    const response = addResponse();
    const image = addResultImage(response, 'blob:https://gemini.google.com/real-fast-model-result');
    observer.inspect();

    await expect(pending).resolves.toEqual({
      image,
      url: 'blob:https://gemini.google.com/real-fast-model-result',
    });
    expect(observer.getState().modelTurn).toBe(response);
    expect(observer.getState().submissionReason).toBe('response_created');
    observer.stop();
  });

  test('OBS-17: imagem de user turn googleusercontent não recebe ownership automático', () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'user-googleusercontent' }).start();

    const userTurn = document.createElement('div');
    userTurn.setAttribute('data-turn-role', 'user');
    const image = document.createElement('img');
    image.src = 'https://lh3.googleusercontent.com/input-reencoded=s0';
    Object.defineProperty(image, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 1536, configurable: true });
    userTurn.appendChild(image);
    document.body.appendChild(userTurn);

    const response = addResponse();
    response.textContent = 'Gerando...';
    observer.inspect();

    expect(observer.getState().modelTurn).toBe(response);
    expect(observer.getState().resultUrl).toBeNull();
    observer.stop();
  });


  test('OBS-18: rd-gg-dl dentro do model turn é aceito antes de dimensões carregarem', async () => {
    const onStateChange = jest.fn();
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({
      jobId: 'rd-gg-dl-result',
      onStateChange,
    }).start();
    const pending = observer.waitForResult(1000);

    const response = addResponse();
    const image = document.createElement('img');
    image.src = 'https://lh3.googleusercontent.com/rd-gg-dl/generated=s1024-rj';
    Object.defineProperty(image, 'naturalWidth', { value: 0, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 0, configurable: true });
    Object.defineProperty(image, 'complete', { value: false, configurable: true });
    response.appendChild(image);

    observer.inspect();

    await expect(pending).resolves.toEqual({
      image,
      url: 'https://lh3.googleusercontent.com/rd-gg-dl/generated=s1024-rj',
    });
    expect(onStateChange.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining(['result_dom_seen', 'result_image_seen', 'result_candidate', 'result_image'])
    );
    observer.stop();
  });


  test('OBS-19: resultado dentro de shadow DOM aberto é detectado automaticamente', async () => {
    const { createGeminiObserver } = loadObserver();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const observer = createGeminiObserver({ jobId: 'shadow-result' }).start();
    const pending = observer.waitForResult(1000);

    const response = document.createElement('model-response');
    const image = document.createElement('img');
    image.src = 'https://lh3.googleusercontent.com/rd-gg-dl/shadow-generated=s1024-rj';
    Object.defineProperty(image, 'naturalWidth', { value: 0, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 0, configurable: true });
    Object.defineProperty(image, 'complete', { value: false, configurable: true });
    response.appendChild(image);
    shadow.appendChild(response);

    await flushMutations();

    await expect(pending).resolves.toEqual({
      image,
      url: 'https://lh3.googleusercontent.com/rd-gg-dl/shadow-generated=s1024-rj',
    });
    expect(observer.getState().modelTurn).toBe(response);
    observer.stop();
  });

  test('OBS-20: rd-gg-dl sem wrapper estrito usa fallback seguro após geração ativa', async () => {
    const onStateChange = jest.fn();
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({
      jobId: 'relaxed-wrapper-result',
      onStateChange,
    }).start();
    const pending = observer.waitForResult(1000);

    addStop();
    observer.inspect();
    expect(observer.getState().generationActiveObserved).toBe(true);

    const shell = document.createElement('section');
    shell.className = 'new-gemini-image-shell';
    const image = document.createElement('img');
    image.src = 'https://lh3.googleusercontent.com/rd-gg-dl/relaxed-generated=s1024-rj';
    Object.defineProperty(image, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 1024, configurable: true });
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
    shell.appendChild(image);
    document.body.appendChild(shell);

    observer.inspect();

    await expect(pending).resolves.toEqual({
      image,
      url: 'https://lh3.googleusercontent.com/rd-gg-dl/relaxed-generated=s1024-rj',
    });
    expect(observer.getState().fallbackOwnerUsed).toBe(true);
    expect(onStateChange.mock.calls.map(call => call[0])).toContain(
      'model_turn_fallback_acquired'
    );
    observer.stop();
  });

  test('OBS-21: rd-gg-dl em user turn continua proibido mesmo com geração ativa', () => {
    const { createGeminiObserver } = loadObserver();
    const observer = createGeminiObserver({ jobId: 'user-rd-gg-dl' }).start();

    addStop();
    observer.inspect();

    const userTurn = document.createElement('div');
    userTurn.setAttribute('data-message-author', 'user');
    const image = document.createElement('img');
    image.src = 'https://lh3.googleusercontent.com/rd-gg-dl/input-copy=s1024-rj';
    Object.defineProperty(image, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 1024, configurable: true });
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
    userTurn.appendChild(image);
    document.body.appendChild(userTurn);

    observer.inspect();

    expect(observer.getState().resultUrl).toBeNull();
    expect(observer.getState().fallbackOwnerUsed).toBe(false);
    observer.stop();
  });

});
