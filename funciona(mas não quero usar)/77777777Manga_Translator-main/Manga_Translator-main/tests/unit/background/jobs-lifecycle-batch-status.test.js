const path = require('path');

const LIFECYCLE_PATH = path.resolve(
    __dirname,
    '../../../extension/background/jobs-lifecycle.js'
);

function loadLifecycle() {
    global.self = global;
    delete global.MangaTranslatorJobsLifecycle;
    jest.isolateModules(() => require(LIFECYCLE_PATH));
    return global.MangaTranslatorJobsLifecycle;
}

describe('background/jobs-lifecycle batch status', () => {
    afterEach(() => {
        delete global.MangaTranslatorJobsLifecycle;
        delete global.chrome;
        jest.restoreAllMocks();
    });

    test('BATCH-STATUS-01: lote com falhas termina como partial_failure, não como sucesso', async () => {
        const sendMessage = jest.fn((_tabId, _message, callback) => callback?.());
        global.chrome = {
            runtime: { lastError: null },
            tabs: { sendMessage },
        };

        const state = {
            stopRequested: false,
            jobQueue: [],
            activeJobsCount: 0,
            activeMangaTabId: 77,
            currentBatchId: 'batch-1',
            completedJobs: 2,
            failedJobs: 1,
            totalJobs: 3,
            isProcessing: true,
        };
        const log = jest.fn();
        const syncState = jest.fn().mockResolvedValue();

        const api = loadLifecycle().createLifecycle({
            state,
            log,
            syncState,
            sendProgress: jest.fn(),
            armWatchdog: jest.fn(),
            clearWatchdog: jest.fn(),
            indexAddJob: jest.fn(),
            indexRemoveJob: jest.fn(),
            indexJobsOfBatch: jest.fn(() => []),
            delay: async () => {},
            generateId: () => 'id',
            markFinalized: jest.fn(),
            isFinalized: jest.fn(() => false),
            finalizedMarkerTtlMinutes: 5,
        });

        await api.processNextJob();

        expect(sendMessage).toHaveBeenCalledWith(
            77,
            expect.objectContaining({
                action: 'BATCH_COMPLETE',
                status: 'partial_failure',
                completedJobs: 2,
                failedJobs: 1,
                totalJobs: 3,
            }),
            expect.any(Function)
        );
        expect(log).toHaveBeenCalledWith(
            'warn',
            'bg',
            'BATCH_DONE',
            expect.stringContaining('falha'),
            expect.objectContaining({ status: 'partial_failure', failedJobs: 1 })
        );
        expect(state.isProcessing).toBe(false);
    });

    test('BATCH-STATUS-02: finalizeJob(fromError=true) incrementa failedJobs e não completedJobs', async () => {
        const store = {
            gemini_job_321: {
                jobId: 'job-1',
                batchId: 'batch-1',
                mangaTabId: 77,
                geminiTabId: 321,
                executionMode: 'temp_chat',
            },
            debugMode: true,
            geminiExecutionMode: 'temp_chat',
        };

        global.chrome = {
            runtime: { lastError: null },
            storage: {
                local: {
                    get: jest.fn(async keys => {
                        const list = Array.isArray(keys) ? keys : [keys];
                        const result = {};
                        for (const key of list) {
                            if (Object.prototype.hasOwnProperty.call(store, key)) {
                                result[key] = store[key];
                            }
                        }
                        return result;
                    }),
                    set: jest.fn(async values => Object.assign(store, values)),
                    remove: jest.fn(async keys => {
                        for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
                    }),
                },
            },
            alarms: {
                create: jest.fn(),
            },
            tabs: {
                remove: jest.fn(),
                sendMessage: jest.fn((_tab, _msg, callback) => callback?.()),
            },
        };

        const entry = {
            geminiTabId: 321,
            jobId: 'job-1',
            batchId: 'batch-1',
        };
        let indexed = true;
        const state = {
            jobQueue: [],
            activeJobsCount: 1,
            completedJobs: 0,
            failedJobs: 0,
            totalJobs: 1,
            stopRequested: true,
            isProcessing: true,
        };

        const api = loadLifecycle().createLifecycle({
            state,
            log: jest.fn(),
            syncState: jest.fn().mockResolvedValue(),
            sendProgress: jest.fn(),
            armWatchdog: jest.fn(),
            clearWatchdog: jest.fn(),
            indexAddJob: jest.fn(),
            indexRemoveJob: jest.fn(() => { indexed = false; }),
            indexJobsOfBatch: jest.fn(() => indexed ? [entry] : []),
            delay: async () => {},
            generateId: () => 'id',
            markFinalized: jest.fn(),
            isFinalized: jest.fn(() => false),
            finalizedMarkerTtlMinutes: 5,
        });

        await expect(api.finalizeJob(321, 77, true)).resolves.toBe(true);

        expect(state.failedJobs).toBe(1);
        expect(state.completedJobs).toBe(0);
        expect(state.activeJobsCount).toBe(0);
    });
});
