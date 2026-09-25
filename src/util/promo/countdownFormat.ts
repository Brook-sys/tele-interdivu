const MINUTE = 60;
const HOUR = 3600;

// Compact countdown for badges: "1h 05m", "12m 30s", "45s"
export function formatCountdownSeconds(seconds: number): string {
  if (seconds <= 0) return '0s';

  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  const restSeconds = Math.floor(seconds % MINUTE);

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`;
  }

  return `${restSeconds}s`;
}
