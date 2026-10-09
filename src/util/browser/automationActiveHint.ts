// Boot hint for the automation cover: landing directly on the automation
// screen (instead of flashing the chat UI while the daemon status is being
// checked) keeps a refresh from ever rendering a chat the daemon's session
// does not belong to. The async boot gates verify the hint and lift the cover
// when the daemon is actually stopped
const AUTOMATION_ACTIVE_HINT_KEY = 'tweb-automation-active';

export function isAutomationActiveHintSet(): boolean {
  try {
    return localStorage.getItem(AUTOMATION_ACTIVE_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeAutomationActiveHint(isActive: boolean) {
  try {
    if (isActive) {
      localStorage.setItem(AUTOMATION_ACTIVE_HINT_KEY, '1');
    } else {
      localStorage.removeItem(AUTOMATION_ACTIVE_HINT_KEY);
    }
  } catch {
    // Storage unavailable — the async gates still decide correctly, only the
    // first paint loses the shortcut
  }
}
