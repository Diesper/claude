const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
    __dirname,
    '../../../extension/background/actions/force-send-activation.js'
);

function chromeCallbackMock(result = {}) {
    return jest.fn((...args) => {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') callback(result);
    });
}

function loadRouter({ executionMode = 'minimized_window' } = {}) {
    global.self = global;
    global.chrome = {
        runtime: {
            id: 'test-extension-id',
            lastError: null,
        },
        storage: {
            local: {
                get: jest.fn((_keys, callback) => callback({ geminiExecutionMode: executionMode })),
            },
        },
        tabs: {
            get: jest.fn((tabId, callback) => callback({
                id: tabId,
                windowId: tabId === 77 ? 7 : 9,
                url: tabId === 321
                    ? 'https://gemini.google.com/app/test'
                    : 'https://manga.example/chapter',
            })),
            update: chromeCallbackMock({}),
            sendMessage: chromeCallbackMock({}),
        },
        windows: {
            update: chromeCallbackMock({}),
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
        let keepAlive;
        keepAlive = listener(request, sender, response => {
            resolve({ keepAlive, response });
        });
    });
}

describe('background attachment activation recovery', () => {
    afterEach(() => {
        delete global.MangaTranslatorRouter;
        delete global.chrome;
    });

    test('ACT-ATT-01: janela minimizada é restaurada/focada antes do retry', async () => {
        const router = loadRouter({ executionMode: 'minimized_window' });
        const listener = router.createMessageRouter();

        const result = await dispatch(listener, {
            action: 'FORCE_ATTACHMENT_ACTIVATION',
            geminiTabId: 321,
            mangaTabId: 77,
            windowId: 9,
            executionMode: 'minimized_window',
        });

        expect(chrome.windows.update).toHaveBeenCalledWith(
            9,
            { state: 'normal', focused: true },
            expect.any(Function)
        );
        expect(chrome.tabs.update).toHaveBeenCalledWith(
            321,
            { active: true },
            expect.any(Function)
        );
        expect(result.response).toEqual(expect.objectContaining({
            ok: true,
            mode: 'minimized_window',
        }));
    });

    test('ACT-ATT-02: restore minimiza Gemini e devolve foco ao mangá', async () => {
        const router = loadRouter({ executionMode: 'minimized_window' });
        const listener = router.createMessageRouter();

        const result = await dispatch(listener, {
            action: 'RESTORE_ATTACHMENT_ACTIVATION',
            geminiTabId: 321,
            mangaTabId: 77,
            windowId: 9,
            executionMode: 'minimized_window',
        });

        expect(chrome.windows.update).toHaveBeenCalledWith(
            9,
            { state: 'minimized', focused: false },
            expect.any(Function)
        );
        expect(chrome.windows.update).toHaveBeenCalledWith(
            7,
            { focused: true },
            expect.any(Function)
        );
        expect(chrome.tabs.update).toHaveBeenCalledWith(
            77,
            { active: true },
            expect.any(Function)
        );
        expect(result.response).toEqual(expect.objectContaining({
            ok: true,
            mode: 'minimized_window',
        }));
    });

    test('ACT-ATT-03: background_delete ativa a aba sem alterar estado de janela', async () => {
        const router = loadRouter({ executionMode: 'background_delete' });
        const listener = router.createMessageRouter();

        const result = await dispatch(listener, {
            action: 'FORCE_ATTACHMENT_ACTIVATION',
            geminiTabId: 321,
            mangaTabId: 77,
            windowId: 9,
            executionMode: 'background_delete',
        });

        expect(chrome.tabs.update).toHaveBeenCalledWith(
            321,
            { active: true },
            expect.any(Function)
        );
        expect(chrome.windows.update).toHaveBeenCalledWith(
            9,
            { focused: true },
            expect.any(Function)
        );
        expect(chrome.windows.update).not.toHaveBeenCalledWith(
            9,
            expect.objectContaining({ state: 'normal' }),
            expect.any(Function)
        );
        expect(result.response).toEqual(expect.objectContaining({
            ok: true,
            mode: 'background_delete',
        }));
    });
});
