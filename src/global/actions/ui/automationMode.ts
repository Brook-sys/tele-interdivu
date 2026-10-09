import type { ActionReturnType, GlobalState } from '../../types';

import { writeAutomationActiveHint } from '../../../util/browser/automationActiveHint';
import { addActionHandler, getActions, getGlobal } from '../../index';

// Cross-tab: when one tab takes over the automation session, every other tab
// of the same browser profile must also leave the chat UI, otherwise the
// Telegram session would be duplicated (AUTH_KEY_DUPLICATED).
const AUTOMATION_CHANNEL = 'tweb-automation-mode';

let broadcastChannel: BroadcastChannel | undefined;

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

// Fired via BroadcastChannel from another tab that entered/left automation mode
addActionHandler('syncAutomationModeFromOtherTab', (global, actions): ActionReturnType => {
  // The current pose is only a hint; re-check the daemon as source of truth
  void fetch('/api/v1/automation/status')
    .then((res) => res.json())
    .then((data) => {
      const shouldBeActive = Boolean(data?.isRunning || data?.isTelegramConnected);
      const currentGlobal = getGlobal();
      if (shouldBeActive !== currentGlobal.automationMode.isActive) {
        if (shouldBeActive) {
          // Drop this tab's client too: keeping it connected while the
          // daemon runs would sustain two users of the same auth key
          actions.disconnect();
          actions.activateAutomationMode();
        } else {
          actions.deactivateAutomationMode();
        }
      }
    })
    .catch(() => undefined);

  return undefined;
});

addActionHandler('consumeAutomationIntroTransition', (global): ActionReturnType => {
  if (!global.automationMode.showIntroTransition) return undefined;

  return {
    ...global,
    automationMode: { ...global.automationMode, showIntroTransition: undefined },
  };
});
