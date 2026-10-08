import type { RegularLangKey } from '../../types/language';
import type { LangFn } from '../localization/types';
import type { OrchestratorOverrideValue } from './automationApi';

export type OverrideFieldType = 'number' | 'boolean' | 'time' | 'mode';

export interface OverrideFieldMeta {
  type: OverrideFieldType;
  labelKey: RegularLangKey;
}

// Client-side mirror of the server whitelist (`OVERRIDEABLE_CONFIG_FIELDS`):
// the fields the orchestration master may define globally. A field missing
// here but present in a master response falls back to its raw name
export const OVERRIDEABLE_FIELDS: Record<string, OverrideFieldMeta> = {
  mode: { type: 'mode', labelKey: 'PromoOrchestrationFieldMode' },
  minDelaySeconds: { type: 'number', labelKey: 'PromoOrchestrationFieldMinDelay' },
  maxDelaySeconds: { type: 'number', labelKey: 'PromoOrchestrationFieldMaxDelay' },
  roundIntervalMinutes: { type: 'number', labelKey: 'PromoOrchestrationFieldRoundInterval' },
  roundTargetSends: { type: 'number', labelKey: 'PromoOrchestrationFieldRoundTarget' },
  minOtherMessages: { type: 'number', labelKey: 'PromoOrchestrationFieldMinOtherMessages' },
  minResendIntervalMinutes: { type: 'number', labelKey: 'PromoOrchestrationFieldMinResendInterval' },
  sleepWindowEnabled: { type: 'boolean', labelKey: 'PromoOrchestrationFieldSleepEnabled' },
  sleepWindowStart: { type: 'time', labelKey: 'PromoOrchestrationFieldSleepStart' },
  sleepWindowEnd: { type: 'time', labelKey: 'PromoOrchestrationFieldSleepEnd' },
  dailyLimit: { type: 'number', labelKey: 'PromoOrchestrationFieldDailyLimit' },
  linkPreviewEnabled: { type: 'boolean', labelKey: 'PromoOrchestrationFieldLinkPreview' },
  microPauseEnabled: { type: 'boolean', labelKey: 'PromoOrchestrationFieldMicroPauseEnabled' },
  microPauseEveryMin: { type: 'number', labelKey: 'PromoOrchestrationFieldMicroPauseMin' },
  microPauseEveryMax: { type: 'number', labelKey: 'PromoOrchestrationFieldMicroPauseMax' },
  microPauseSeconds: { type: 'number', labelKey: 'PromoOrchestrationFieldMicroPauseSeconds' },
  extractorEnabled: { type: 'boolean', labelKey: 'PromoOrchestrationFieldExtractor' },
  templateRotationEnabled: { type: 'boolean', labelKey: 'PromoOrchestrationFieldRotation' },
};

export const OVERRIDE_FIELD_IDS = Object.keys(OVERRIDEABLE_FIELDS);

export function getOverrideFieldLabel(field: string, lang: LangFn): string {
  const meta = OVERRIDEABLE_FIELDS[field];
  return meta ? lang(meta.labelKey) : field;
}

export function formatOverrideValue(field: string, value: OrchestratorOverrideValue, lang: LangFn): string {
  const meta = OVERRIDEABLE_FIELDS[field];
  if (!meta) return String(value);
  switch (meta.type) {
    case 'mode':
      return value === 'continuous'
        ? lang('PromoAutomationModeContinuous')
        : lang('PromoAutomationModeManual');
    case 'boolean':
      return value ? lang('PromoOrchestrationValueOn') : lang('PromoOrchestrationValueOff');
    default:
      return String(value);
  }
}
