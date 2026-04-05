import {
  type ThreadId,
  type ThreadBrowserState,
  type GitActionProgressEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { resetServerStateForTests } from "./rpc/serverState";
import { resetWsConnectionStateForTests } from "./rpc/wsConnectionState";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const gitActionProgressListeners = new Set<(payload: GitActionProgressEvent) => void>();
const fallbackBrowserStateListeners = new Set<(state: ThreadBrowserState) => void>();
const fallbackBrowserStates = new Map<ThreadId, ThreadBrowserState>();

function defaultBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function defaultBrowserTitle(url: string): string {
  if (url === "about:blank") {
    return "New tab";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function createFallbackTab(url = "about:blank") {
  return {
    id: crypto.randomUUID(),
    url,
    title: defaultBrowserTitle(url),
    status: "live" as const,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url,
    lastError: null,
  };
}

function cloneBrowserState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function getFallbackBrowserState(threadId: ThreadId): ThreadBrowserState {
  const existing = fallbackBrowserStates.get(threadId);
  if (existing) {
    return existing;
  }
  const initial = defaultBrowserState(threadId);
  fallbackBrowserStates.set(threadId, initial);
  return initial;
}

function emitFallbackBrowserState(threadId: ThreadId): ThreadBrowserState {
  const state = cloneBrowserState(getFallbackBrowserState(threadId));
  for (const listener of fallbackBrowserStateListeners) {
    listener(state);
  }
  return state;
}

function ensureFallbackBrowserWorkspace(threadId: ThreadId): ThreadBrowserState {
  const state = getFallbackBrowserState(threadId);
  if (state.tabs.length === 0) {
    const tab = createFallbackTab();
    state.tabs = [tab];
    state.activeTabId = tab.id;
  }
  state.open = true;
  return state;
}

function resolveFallbackBrowserTab(state: ThreadBrowserState, tabId?: string) {
  const existing =
    (tabId ? state.tabs.find((tab) => tab.id === tabId) : undefined) ??
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  if (existing) {
    return existing;
  }
  const tab = createFallbackTab();
  state.tabs = [tab];
  state.activeTabId = tab.id;
  state.open = true;
  return tab;
}

export function __resetWsNativeApiForTests() {
  instance = null;
  __resetWsRpcClientForTests();
  resetRequestLatencyStateForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const rpcClient = getWsRpcClient();

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: rpcClient.git.pull,
      status: rpcClient.git.status,
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
    },
    provider: {
      getComposerCapabilities: (input) =>
        transport.request(WS_METHODS.providerGetComposerCapabilities, input),
      listSkills: (input) => transport.request(WS_METHODS.providerListSkills, input),
      listModels: (input) => transport.request(WS_METHODS.providerListModels, input),
    },
    orchestration: {
      getSnapshot: rpcClient.orchestration.getSnapshot,
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration
          .replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback, options) =>
        rpcClient.orchestration.onDomainEvent(callback, options),
    },
    browser: {
      open: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.open(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        if (input.initialUrl && state.tabs.length > 0) {
          const activeTab = resolveFallbackBrowserTab(state);
          activeTab.url = input.initialUrl;
          activeTab.title = defaultBrowserTitle(input.initialUrl);
          activeTab.lastCommittedUrl = input.initialUrl;
        }
        return emitFallbackBrowserState(input.threadId);
      },
      close: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.close(input);
        }
        const state = getFallbackBrowserState(input.threadId);
        state.open = false;
        state.activeTabId = null;
        state.tabs = [];
        state.lastError = null;
        return emitFallbackBrowserState(input.threadId);
      },
      hide: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.hide(input);
        }
      },
      getState: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.getState(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      setPanelBounds: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.setPanelBounds(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      navigate: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.navigate(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = resolveFallbackBrowserTab(state, input.tabId);
        tab.url = input.url;
        tab.title = defaultBrowserTitle(input.url);
        tab.lastCommittedUrl = input.url;
        tab.lastError = null;
        tab.status = "live";
        state.activeTabId = tab.id;
        return emitFallbackBrowserState(input.threadId);
      },
      reload: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.reload(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      goBack: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.goBack(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      goForward: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.goForward(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      newTab: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.newTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = createFallbackTab(input.url);
        state.tabs = [...state.tabs, tab];
        if (input.activate !== false || !state.activeTabId) {
          state.activeTabId = tab.id;
        }
        return emitFallbackBrowserState(input.threadId);
      },
      closeTab: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.closeTab(input);
        }
        const state = getFallbackBrowserState(input.threadId);
        state.tabs = state.tabs.filter((tab) => tab.id !== input.tabId);
        if (state.tabs.length === 0) {
          state.open = false;
          state.activeTabId = null;
        } else if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0]?.id ?? null;
        }
        return emitFallbackBrowserState(input.threadId);
      },
      selectTab: async (input) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.selectTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = resolveFallbackBrowserTab(state, input.tabId);
        state.activeTabId = tab.id;
        return emitFallbackBrowserState(input.threadId);
      },
      openDevTools: async (input) => {
        if (window.desktopBridge) {
          await window.desktopBridge.browser.openDevTools(input);
        }
      },
      onState: (callback) => {
        if (window.desktopBridge) {
          return window.desktopBridge.browser.onState(callback);
        }
        fallbackBrowserStateListeners.add(callback);
        return () => {
          fallbackBrowserStateListeners.delete(callback);
        };
      },
    },
  };

  instance = { api };
  return api;
}
