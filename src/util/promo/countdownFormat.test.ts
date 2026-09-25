import { describe, expect, it } from 'vitest';

import { formatCountdownSeconds } from './countdownFormat';

describe('formatCountdownSeconds', () => {
  it('formats seconds below a minute', () => {
    expect(formatCountdownSeconds(45)).toBe('45s');
    expect(formatCountdownSeconds(1)).toBe('1s');
  });

  it('pads seconds in the minute range', () => {
    expect(formatCountdownSeconds(12 * 60 + 5)).toBe('12m 05s');
  });

  it('pads minutes in the hour range', () => {
    expect(formatCountdownSeconds(3600 + 5 * 60)).toBe('1h 05m');
  });

  it('handles zero and negative values', () => {
    expect(formatCountdownSeconds(0)).toBe('0s');
    expect(formatCountdownSeconds(-10)).toBe('0s');
  });
});
