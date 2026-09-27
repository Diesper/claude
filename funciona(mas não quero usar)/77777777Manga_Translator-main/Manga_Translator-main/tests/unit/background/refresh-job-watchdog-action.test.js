const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
  __dirname,
  '../../../extension/background/actions/refresh-job-watchdog.js'
);

function loadRouter() {
  global.self = global;
  global.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
    },
  };

  delete global.MangaTranslatorRouter;
  jest.isolateModules(() => {
    require(ROUTER_PATH);
    require(ACTION_PATH);
  });
  return global.MangaTranslatorRouter;
}

function dispatch(listener, request, sender = {
  tab: { id: 321, url: 'https://gemini.google.com/app/test' },
}) {
  return new Promise(resolve => {
    const keepAlive = listener(request, sender, response => {
      resolve({ keepAlive, response });
    });
  });
}

describe('background refresh-job-watchdog action', () => {
  afterEach(() => {
    delete global.MangaTranslatorRouter;
    delete global.chrome;
    delete global.self;
    jest.restoreAllMocks();
  });

  test('WATCHDOG-REFRESH-01: job dono rearma watchdog usando dados canônicos', async () => {
    const router = loadRouter();
    const armWatchdog = jest.fn(async (_mangaTabId, _index, geminiTabId) => geminiTabId);
    const ensureInitialized = jest.fn().mockResolvedValue();
    const log = jest.fn();
    const state = {
      jobIndex: [{
        jobId: 'job-1',
        geminiTabId: 321,
        mangaTabId: 77,
        index: 4,
      }],
    };
    const tabIdentity = {
      resolveCanonicalTabId: jest.fn(async tabId => tabId),
    };

    const listener = router.createMessageRouter({
      contextFactory: () => ({
        state,
        armWatchdog,
        ensureInitialized,
        tabIdentity,
        log,
      }),
    });

    const result = await dispatch(listener, {
      action: 'REFRESH_JOB_WATCHDOG',
      jobId: 'job-1',
      geminiTabId: 321,
      mangaTabId: 77,
      index: 4,
    });

    expect(ensureInitialized).toHaveBeenCalledTimes(1);
    expect(armWatchdog).toHaveBeenCalledWith(77, 4, 321, 'job-1');
    expect(result.response).toEqual(expect.objectContaining({
      ok: true,
      refreshed: true,
      geminiTabId: 321,
    }));
  });

  test('WATCHDOG-REFRESH-02: aba que não possui o job é rejeitada', async () => {
    const router = loadRouter();
    const armWatchdog = jest.fn();
    const listener = router.createMessageRouter({
      contextFactory: () => ({
        state: {
          jobIndex: [{
            jobId: 'job-1',
            geminiTabId: 321,
            mangaTabId: 77,
            index: 4,
          }],
        },
        armWatchdog,
        ensureInitialized: jest.fn().mockResolvedValue(),
        tabIdentity: {
          resolveCanonicalTabId: jest.fn(async tabId => tabId),
        },
        log: jest.fn(),
      }),
    });

    const result = await dispatch(
      listener,
      { action: 'REFRESH_JOB_WATCHDOG', jobId: 'job-1' },
      { tab: { id: 999, url: 'https://gemini.google.com/app/other' } }
    );

    expect(armWatchdog).not.toHaveBeenCalled();
    expect(result.response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    }));
  });
});
