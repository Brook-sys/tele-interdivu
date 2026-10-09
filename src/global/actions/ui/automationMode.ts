import type { ActionReturnType, GlobalState } from '../../types';

import { writeAutomationActiveHint } from '../../../util/browser/automationActiveHint';
import { addActionHandler, getActions, getGlobal } from '../../index';

// Cross-tab: when one tab takes over the automation session, every other tab
// of the same browser profile must also leave the chat UI, otherwise the
// Telegram session would be duplicated (AUTH_KEY_DUPLICATED).
const AUTOMATION_CHANNEL = 'tweb-automation-mode';
// One failed status check must not park a tab on a dead chat screen (or on
// the boot loading forever): retry briefly, then release only the boot
// pending state — an established automation cover never falls to a fetch error
const SYNC_RETRY_MS = 2_500;
const SYNC_MAX_RETRIES = 10;
let broadcastChannel: BroadcastChannel | undefined;

async function decideAutomationModeFromDaemon(attempt: number): Promise<void> {
  const actions = getActions();
  try {
    const res = await fetch('/api/v1/automation/status');
    if (!res.ok) throw new Error('status request failed');
    const data = await res.json();
    const shouldBeActive = Boolean(data?.isRunning || data?.isTelegramConnected);
    const { automationMode } = getGlobal();
    if (shouldBeActive) {
      if (!automationMode.isActive) {
        // Drop this tab's client too: keeping it connected while the daemon
        // runs would sustain two users of the same auth key
        actions.disconnect();
        actions.activateAutomationMode();
      }
      return;
    }
    if (automationMode.isActive || automationMode.isPendingDecision) {
      actions.deactivateAutomationMode();
    }
  } catch {
    if (attempt < SYNC_MAX_RETRIES) {
      window.setTimeout(() => {
        void decideAutomationModeFromDaemon(attempt + 1);
      }, SYNC_RETRY_MS);
      return;
    }
    const { automationMode } = getGlobal();
    if (automationMode.isPendingDecision && !automationMode.isActive) {
      actions.deactivateAutomationMode();
    }
  }
}

function applyAutomationMode(global: GlobalState, isActive: boolean): GlobalState {
  return {
    ...global,
    automationMode: {
      isActive,
      ...(isActive ? { showIntroTransition: true } : {}),
    },
  };
}

function getBroadcastChannel(): BroadcastChannel | undefined {
  if (!('BroadcastChannel' in window)) return undefined;
  if (!broadcastChannel) {
    broadcastChannel = new BroadcastChannel(AUTOMATION_CHANNEL);
    broadcastChannel.onmessage = (event) => {
      const isActive = Boolean(event.data?.isActive);
      const currentGlobal = getGlobal();
      if (isActive !== currentGlobal.automationMode.isActive) {
        getActions().syncAutomationModeFromOtherTab();
      }
    };
  }
  return broadcastChannel;
}

addActionHandler('activateAutomationMode', (global): ActionReturnType => {
  writeAutomationActiveHint(true);
  getBroadcastChannel()?.postMessage({ isActive: true });
  return applyAutomationMode(global, true);
});

addActionHandler('deactivateAutomationMode', (global): ActionReturnType => {
  writeAutomationActiveHint(false);
  getBroadcastChannel()?.postMessage({ isActive: false });
  return applyAutomationMode(global, false);
});

// Fired via BroadcastChannel from another tab that entered/left automation
// mode, and at the boot of a non-master tab: the current pose is only a hint,
// the daemon status is the source of truth
addActionHandler('syncAutomationModeFromOtherTab', (): ActionReturnType => {
  void decideAutomationModeFromDaemon(0);
  return undefined;
});

addActionHandler('consumeAutomationIntroTransition', (global): ActionReturnType => {
  if (!global.automationMode.showIntroTransition) return undefined;

  return {
    ...global,
    automationMode: { ...global.automationMode, showIntroTransition: undefined },
  };
});
