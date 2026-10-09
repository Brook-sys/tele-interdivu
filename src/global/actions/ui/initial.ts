import { addCallback } from '../../../lib/teact/teactn';

import type { ApiNotification } from '../../../api/types';
import type { ActionReturnType, GlobalState } from '../../types';
import { type LangCode } from '../../../types';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import { IS_ELECTRON, IS_MULTIACCOUNT_SUPPORTED, IS_TAURI } from '../../../util/browser/globalEnvironment';
import {
  IS_ANDROID, IS_IOS, IS_LINUX,
  IS_MAC_OS, IS_SAFARI, IS_TOUCH_ENV, IS_WINDOWS,
} from '../../../util/browser/windowEnvironment';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import generateUniqueId from '../../../util/generateUniqueId';
import { setTimeFormat as setLocalizedTimeFormat } from '../../../util/localization';
import { subscribe, unsubscribe } from '../../../util/notifications';
import { oldSetLanguage } from '../../../util/oldLangProvider';
import { decryptSessionByCurrentHash } from '../../../util/passcode';
import { applyPerformanceSettings } from '../../../util/perfomanceSettings';
import { hasStoredSession, loadStoredSession, storeSession } from '../../../util/sessions';
import switchTheme from '../../../util/switchTheme';
import { getSystemTheme, setSystemThemeChangeCallback } from '../../../util/systemTheme';
import { startWebsync, stopWebsync } from '../../../util/websync';
import { callApi } from '../../../api/gramjs';
import { clearCaching, setupCaching } from '../../cache';
import { addActionHandler, getActions, getGlobal, setGlobal } from '../../index';
import { updateSharedSettings } from '../../reducers';
import { updateAuth } from '../../reducers/auth';
import { updateTabState } from '../../reducers/tabs';
import {
  selectCanAnimateInterface,
  selectPerformanceSettings,
  selectSettingsKeys,
  selectTabState,
  selectTheme,
} from '../../selectors';
import { selectSharedSettings } from '../../selectors/sharedState';
import { destroySharedStatePort, initSharedState } from '../../shared/sharedStateConnector';

const HISTORY_ANIMATION_DURATION = 450;

async function checkIsAutomationRunning(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/automation/status');
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.isRunning);
  } catch {
    return false;
  }
}

// Minimal daemon status for connection-safety decisions
async function fetchDaemonStatusSafety(): Promise<{
  isTelegramConnected: boolean;
  isRunning: boolean;
  sessionSafetyWaitSeconds: number;
} | undefined> {
  try {
    const res = await fetch('/api/v1/automation/status');
    if (!res.ok) return undefined;
    const data = await res.json();
    return {
      isTelegramConnected: Boolean(data?.isTelegramConnected),
      isRunning: Boolean(data?.isRunning),
      sessionSafetyWaitSeconds: Math.max(0, Number(data?.sessionSafetyWaitSeconds) || 0),
    };
  } catch {
    return undefined;
  }
}

// Reconnecting the browser client with the same auth key while the Telegram
// server may still consider it in use (after an abrupt daemon end) destroys
// the session permanently (AUTH_KEY_DUPLICATED, postmortem 72). The daemon
// reports the remaining wait in its status; when it is unreachable a
// container restart is likely in progress, so hold off too — bounded by the
// poll cap below so a genuinely absent daemon never blocks the login screen
const SESSION_SAFETY_POLL_MS = 15_000;
const SESSION_SAFETY_MAX_POLLS = 12;

async function connectBrowserClientWhenSessionSafe(pollCount = 0) {
  const { initApi, activateAutomationMode, deactivateAutomationMode } = getActions();
  if (!hasStoredSession() || pollCount >= SESSION_SAFETY_MAX_POLLS) {
    // Connecting means the daemon does not own the session: lift the
    // automation cover (a stale boot hint may have set it) so the UI and
    // the connection state stay consistent
    deactivateAutomationMode();
    initApi();
    return;
  }
  const status = await fetchDaemonStatusSafety();
  // The daemon owns the session right now (automation running or mid
  // takeover): connecting the browser client would duplicate the auth key
  if (status && (status.isRunning || status.isTelegramConnected)) {
    activateAutomationMode();
    return;
  }
  if (status && status.sessionSafetyWaitSeconds <= 0) {
    deactivateAutomationMode();
    initApi();
    return;
  }
  window.setTimeout(() => {
    void connectBrowserClientWhenSessionSafe(pollCount + 1);
  }, SESSION_SAFETY_POLL_MS);
}

// Decides how the browser resumes its Telegram connection after a pause
// (boot or passcode unlock): the daemon may own the session (automation
// mode, no local connection), or the session may still be "in use"
// server-side after an abrupt daemon end (cooldown). Connecting the browser
// client in either state duplicates the auth key, destroying the session
export async function resumeBrowserClientConnection() {
  const isAutomationRunning = await checkIsAutomationRunning();
  if (isAutomationRunning) {
    getActions().activateAutomationMode();
    return;
  }
  void connectBrowserClientWhenSessionSafe();
}

// Mirrors the panel handover for remote starts and reports browser presence:
// the daemon asks for the session (browserPendingStart) or takes it over, and
// this tab yields its client within one beat — two concurrent users of the
// same auth key destroy the session (postmortem 72). The cadence keeps the
// report fresh and bounds the accidental-overlap window; the 2 min staleness
// window on the daemon side covers background tabs whose timers browsers
// throttle to ~1/min
const DAEMON_PRESENCE_POLL_MS = 2_500;
let isDaemonPresenceWatcherStarted = false;

// Same identity the daemon derives from a session object (mirrored in
// server/api/routes.ts — pure FNV-1a, no WebCrypto, which is unavailable
// when the UI is served over plain HTTP). The daemon compares it with the
// saved session to detect a re-login before a remote start
function computeSessionFingerprint(): string | undefined {
  const keys = loadStoredSession()?.keys;
  if (!keys || !Object.keys(keys).length) return undefined;
  const serialized = Object.keys(keys).sort()
    .map((dcId) => `${dcId}:${String(keys[Number(dcId)] ?? '')}`)
    .join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function reportBrowserPresence() {
  const global = getGlobal();
  if (!selectTabState(global).isMasterTab) return;
  if (!hasStoredSession()) return;
  const isClientConnected = global.connectionState === 'connectionStateReady'
    && !global.automationMode.isActive;
  let status: {
    isTelegramConnected: boolean;
    isRunning: boolean;
    browserPendingStart: boolean;
  } | undefined;
  try {
    const res = await fetch('/api/v1/automation/browser-presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isClientConnected, sessionFingerprint: computeSessionFingerprint() }),
    });
    if (!res.ok) return;
    const data = await res.json();
    status = {
      isTelegramConnected: Boolean(data?.isTelegramConnected),
      isRunning: Boolean(data?.isRunning),
      browserPendingStart: Boolean(data?.browserPendingStart),
    };
  } catch {
    // Daemon unreachable — no presence to report, no takeover to yield to
    return;
  }
  if (!isClientConnected || !status) return;
  if (!status.browserPendingStart && !status.isTelegramConnected && !status.isRunning) return;
  // The daemon owns the session now (or asked for it): yield the browser
  // client exactly like the local panel start does (disconnect + automation
  // mode)
  await callApi('disconnect');
  getActions().activateAutomationMode();
}

function startDaemonPresenceWatcher() {
  if (isDaemonPresenceWatcherStarted) return;
  isDaemonPresenceWatcherStarted = true;
  window.setInterval(() => {
    void reportBrowserPresence();
  }, DAEMON_PRESENCE_POLL_MS);
}

setSystemThemeChangeCallback((theme) => {
  let global = getGlobal();

  if (!global.isInited || !selectSharedSettings(global).shouldUseSystemTheme) return;

  global = updateSharedSettings(global, { theme });
  setGlobal(global);
});

addActionHandler('switchMultitabRole', async (global, actions, payload): Promise<void> => {
  const { isMasterTab, tabId = getCurrentTabId() } = payload;

  if (isMasterTab === selectTabState(global, tabId).isMasterTab) {
    callApi('broadcastLocalDbUpdateFull');
    return;
  }

  global = updateTabState(global, {
    isMasterTab,
  }, tabId);
  setGlobal(global, { forceSyncOnIOs: true });

  if (!isMasterTab) {
    void unsubscribe();
    actions.destroyConnection();
    stopWebsync();
    destroySharedStatePort();
    clearCaching();
    actions.onSomeTabSwitchedMultitabRole();
    // A non-master tab never owns the client, but it must still cover the
    // UI while the daemon owns the session: showing the chat screen invites
    // interactions that fight the daemon for the auth key (postmortem 74)
    actions.syncAutomationModeFromOtherTab();
  } else {
    if (global.passcode.hasPasscode && !global.passcode.isScreenLocked) {
      const { sessionJson } = await decryptSessionByCurrentHash();
      const session = JSON.parse(sessionJson);
      storeSession(session);
    }

    if (hasStoredSession()) {
      setupCaching();
    }

    global = getGlobal();
    if (!global.passcode.hasPasscode || !global.passcode.isScreenLocked) {
      if (global.connectionState === 'connectionStateReady') {
        global = {
          ...global,
          connectionState: 'connectionStateConnecting',
        };
        setGlobal(global);
      }

      const isAutomationRunning = await checkIsAutomationRunning();
      if (isAutomationRunning) {
        // Daemon owns the session: enter full-screen automation mode and do
        // NOT initApi — connecting the browser client here would duplicate
        // the Telegram key (AUTH_KEY_DUPLICATED). F5/refresh re-enters this
        // same state.
        actions.activateAutomationMode();
      } else {
        // Daemon is not running: only connect once the session key is safe
        // to use again (postmortem 72)
        void connectBrowserClientWhenSessionSafe();
      }
    }

    startDaemonPresenceWatcher();

    global = getGlobal();
    startWebsync();
    if (IS_MULTIACCOUNT_SUPPORTED) {
      initSharedState(global.sharedState);
    }
  }
});

addActionHandler('onSomeTabSwitchedMultitabRole', async (global): Promise<void> => {
  if (global.passcode.hasPasscode && !global.passcode.isScreenLocked) {
    const { sessionJson } = await decryptSessionByCurrentHash();
    const session = JSON.parse(sessionJson);
    storeSession(session);
  }

  callApi('broadcastLocalDbUpdateFull');
});

addActionHandler('initShared', (): ActionReturnType => {
  startWebsync();
});

addActionHandler('initMain', (global): ActionReturnType => {
  const { hasWebNotifications, hasPushNotifications } = selectSettingsKeys(global);
  if (hasWebNotifications && hasPushNotifications) {
    // Most of the browsers only show the notifications permission prompt after the first user gesture.
    const events = ['click', 'keypress'];
    const subscribeAfterUserGesture = () => {
      void subscribe();
      events.forEach((event) => {
        document.removeEventListener(event, subscribeAfterUserGesture);
      });
    };
    events.forEach((event) => {
      document.addEventListener(event, subscribeAfterUserGesture, { once: true });
    });
  }
});

addCallback((global: GlobalState) => {
  const tabState = selectTabState(global, getCurrentTabId());
  if (!tabState?.shouldInit) return;

  global = getGlobal();

  global = updateTabState(global, {
    shouldInit: false,
  }, tabState.id);

  const {
    messageTextSize, language, shouldUseSystemTheme, timeFormat,
  } = selectSharedSettings(global);

  const globalTheme = selectTheme(global);
  const systemTheme = getSystemTheme();
  const theme = shouldUseSystemTheme ? systemTheme : globalTheme;

  const performanceType = selectPerformanceSettings(global);

  void oldSetLanguage(language as LangCode, undefined);
  setLocalizedTimeFormat(timeFormat);

  requestMutation(() => {
    document.documentElement.style.setProperty(
      '--composer-text-size', `${Math.max(messageTextSize, IS_IOS ? 16 : 15)}px`,
    );
    document.documentElement.style.setProperty('--message-meta-height', `${Math.floor(messageTextSize * 1.25)}px`);
    document.documentElement.style.setProperty('--message-text-size', `${messageTextSize}px`);
    document.documentElement.setAttribute('data-message-text-size', messageTextSize.toString());
    document.body.classList.add('initial');
    document.body.classList.add(IS_TOUCH_ENV ? 'is-touch-env' : 'is-pointer-env');
    applyPerformanceSettings(performanceType);

    if (IS_IOS) {
      document.body.classList.add('is-ios');
    } else if (IS_ANDROID) {
      document.body.classList.add('is-android');
    } else if (IS_MAC_OS) {
      document.body.classList.add('is-macos');
    } else if (IS_WINDOWS) {
      document.body.classList.add('is-windows');
    } else if (IS_LINUX) {
      document.body.classList.add('is-linux');
    }
    if (IS_SAFARI) {
      document.body.classList.add('is-safari');
    }
    if (IS_TAURI) {
      document.body.classList.add('is-tauri');
    }
    if (IS_ELECTRON) { // Legacy, pretend to be Tauri
      document.body.classList.add('is-tauri');
    }
  });

  const canAnimate = selectCanAnimateInterface(global);

  switchTheme(theme, canAnimate);
  // Make sure global has the latest theme. Will cause `switchTheme` on change
  global = updateSharedSettings(global, { theme });

  startWebsync();

  setGlobal(global);
});

addActionHandler('setInstallPrompt', (global, actions, payload): ActionReturnType => {
  const { canInstall, tabId = getCurrentTabId() } = payload;
  return updateTabState(global, {
    canInstall,
  }, tabId);
});

addActionHandler('setIsUiReady', (global, actions, payload): ActionReturnType => {
  const { uiReadyState, tabId = getCurrentTabId() } = payload;

  if (uiReadyState === 2) {
    requestMutation(() => {
      document.body.classList.remove('initial');
    });
  }

  return updateTabState(global, {
    uiReadyState,
  }, tabId);
});

addActionHandler('setAuthPhoneNumber', (global, actions, payload): ActionReturnType => {
  const { phoneNumber } = payload;

  return updateAuth(global, {
    phoneNumber,
  });
});

addActionHandler('setAuthRememberMe', (global, actions, payload): ActionReturnType => {
  return updateAuth(global, {
    rememberMe: Boolean(payload.value),
  });
});

addActionHandler('clearAuthErrorKey', (global): ActionReturnType => {
  return updateAuth(global, {
    errorKey: undefined,
  });
});

addActionHandler('disableHistoryAnimations', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  setTimeout(() => {
    global = getGlobal();
    global = updateTabState(global, {
      shouldSkipHistoryAnimations: false,
    }, tabId);
    setGlobal(global);

    requestMutation(() => {
      document.body.classList.remove('no-animate');
    });
  }, HISTORY_ANIMATION_DURATION);

  global = updateTabState(global, {
    shouldSkipHistoryAnimations: true,
  }, tabId);
  setGlobal(global, { forceSyncOnIOs: true });
});

addActionHandler('showNotification', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId(), ...notification } = payload;
  const hasLocalId = notification.localId;
  notification.localId ||= generateUniqueId();

  const newNotifications = [...selectTabState(global, tabId).notifications];
  const existingNotificationIndex = newNotifications.findIndex((n) => (
    hasLocalId ? n.localId === notification.localId : n.message === notification.message
  ));
  if (existingNotificationIndex !== -1) {
    newNotifications.splice(existingNotificationIndex, 1);
  }

  newNotifications.push(notification as ApiNotification);

  return updateTabState(global, {
    notifications: newNotifications,
  }, tabId);
});

addActionHandler('dismissNotification', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload;
  const newNotifications = selectTabState(global, tabId)
    .notifications.filter(({ localId }) => localId !== payload.localId);

  return updateTabState(global, {
    notifications: newNotifications,
  }, tabId);
});
