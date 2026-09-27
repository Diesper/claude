'use strict';
// background/actions/refresh-job-watchdog.js
//
// Recomeça o prazo do watchdog quando o content script confirma que a geração
// realmente começou. Isso evita consumir o timeout com abertura da aba,
// attachment e submit, mantendo ownership estrito pelo jobId/aba Gemini.

(function(scope) {
  if (!scope.MangaTranslatorRouter ||
      typeof scope.MangaTranslatorRouter.registerAction !== 'function') {
    throw new Error('MangaTranslatorRouter indisponível para registrar refresh-job-watchdog');
  }

  function validate(request) {
    if (!request || !request.jobId) {
      return { code: 'INVALID_PAYLOAD', message: 'jobId ausente' };
    }
    return null;
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'refresh-job-watchdog',
    meta: {
      allowedSources: ['gemini'],
    },
    validate,
    async execute(request, context) {
      if (typeof context.ensureInitialized === 'function') {
        await context.ensureInitialized();
      }
      if (typeof context.armWatchdog !== 'function') {
        throw new Error('armWatchdog indisponível');
      }

      const senderTabId = context.sender && context.sender.tab
        ? context.sender.tab.id
        : null;
      if (senderTabId === null || senderTabId === undefined) {
        throw new Error('Aba remetente ausente');
      }

      const entries = Array.isArray(context.state && context.state.jobIndex)
        ? context.state.jobIndex
        : [];
      const indexed = entries.find(entry => entry && entry.jobId === request.jobId);
      if (!indexed) {
        throw new Error('Job não encontrado no índice durável');
      }

      const resolveCanonical = context.tabIdentity &&
        typeof context.tabIdentity.resolveCanonicalTabId === 'function'
          ? tabId => context.tabIdentity.resolveCanonicalTabId(tabId)
          : async tabId => tabId;

      const canonicalSender = await resolveCanonical(senderTabId);
      const canonicalIndexed = await resolveCanonical(indexed.geminiTabId);
      if (String(canonicalSender) !== String(canonicalIndexed)) {
        throw new Error('Aba remetente não é dona do job');
      }

      const refreshedTabId = await context.armWatchdog(
        indexed.mangaTabId,
        indexed.index,
        canonicalIndexed,
        indexed.jobId
      );

      context.log?.(
        'info',
        'bg',
        'JOB_WATCHDOG_REFRESH',
        'Watchdog reiniciado a partir do início real da geração',
        {
          index: indexed.index,
          geminiTabId: refreshedTabId,
          jobIdPrefix: String(indexed.jobId).slice(0, 8),
        }
      );

      return {
        refreshed: true,
        geminiTabId: refreshedTabId,
      };
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
