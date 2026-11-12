'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...values) {
  const result = await ipcRenderer.invoke(channel, ...values);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('calendar', {
  load: () => invoke('calendar:load'),
  refresh: () => invoke('calendar:refresh'),
  detail: id => invoke('calendar:detail', id),
  chatBatch: id => invoke('calendar:chat-batch', id),
  acceptForwardedLine: (batchId, messageIndex, lineIndex, input) => invoke('calendar:forwarded-accept', batchId, messageIndex, lineIndex, input),
  reviewForwardedBatch: id => invoke('calendar:forwarded-review', id),
  finishChatBatch: (id, candidateIds) => invoke('calendar:chat-batch-finish', id, candidateIds),
  markMessageSeen: (kind, id) => invoke('calendar:message-seen', kind, id),
  replyInBrity: id => invoke('calendar:brity-reply', id),
  create: input => invoke('calendar:create', input),
  update: (id, input) => invoke('calendar:update', id, input),
  markReferenceSeen: id => invoke('calendar:reference-seen', id),
  acceptCandidate: (id, input) => invoke('calendar:candidate-accept', id, input),
  applyCandidateChange: (id, targetId) => invoke('calendar:candidate-apply', id, targetId),
  discardCandidates: input => invoke('calendar:candidate-discard', input),
  restoreCandidate: id => invoke('calendar:candidate-restore', id),
  setDone: (id, done, index) => invoke('calendar:done', id, done, index),
  refine: id => invoke('calendar:refine', id),
  refinePreview: id => invoke('calendar:refine-preview', id),
  setPinned: (id, pinned) => invoke('calendar:pinned', id, pinned),
  setImportant: (id, important) => invoke('calendar:important', id, important),
  setReplied: (id, replied) => invoke('calendar:replied', id, replied),
  setProfile: input => invoke('calendar:profile', input),
  connectAi: (provider, key) => invoke('calendar:ai-connect', provider, key),
  openAiGuide: page => invoke('calendar:open-ai-guide', page),
  claudeLogin: () => invoke('calendar:claude-login'),
  claudeStatus: () => invoke('calendar:claude-status'),
  claudeInstall: () => invoke('calendar:claude-install'),
  claudeInstallCopy: () => invoke('calendar:claude-install-copy'),
  connectCollector: () => invoke('calendar:collector-connect'),
  finishCollectorFirstImport: automatic => invoke('calendar:collector-first-import-finish', automatic),
  collectNow: force => invoke('calendar:collect-now', force === true),
  previewRange: (from, to) => invoke('calendar:range-preview', from, to),
  importRange: (from, to) => invoke('calendar:range-import', from, to),
  stopRange: () => invoke('calendar:range-stop'),
  classifyRange: () => invoke('calendar:range-classify'),
  setAutoRefresh: input => invoke('calendar:auto-refresh', input),
  listChatRooms: () => invoke('calendar:chat-rooms-list'),
  setChatRooms: rooms => invoke('calendar:chat-rooms-save', rooms),
  setAutomatic: enabled => invoke('calendar:automatic', enabled),
  chooseDownloads: () => invoke('calendar:downloads-choose'),
  resetDownloads: () => invoke('calendar:downloads-reset'),
  openDownloads: () => invoke('calendar:downloads-open'),
  createBackup: () => invoke('calendar:backup-create'),
  restoreBackup: () => invoke('calendar:backup-restore'),
  resolveRules: choice => invoke('calendar:rules-resolve', choice),
  createShortcut: () => invoke('calendar:shortcut-create'),
  checkUpdate: () => invoke('calendar:update-check'),
  applyUpdate: () => invoke('calendar:update-apply'),
  openUpdatePage: () => invoke('calendar:update-page'),
  dismissWhatsNew: () => invoke('calendar:whats-new-dismiss'),
  changes: () => invoke('calendar:changes'),
  setShowPeriods: enabled => invoke('calendar:periods', enabled),
  openRules: () => invoke('calendar:rules'),
  openAttachment: (id, index, reveal) => invoke('calendar:attachment', id, index, reveal),
  copyWorkPrompt: id => invoke('calendar:copy-work', id),
  onChange: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('calendar:changed', listener);
    return () => ipcRenderer.removeListener('calendar:changed', listener);
  }
});
