import { useEffect, useState } from 'react';

/** The device clock, read again every `intervalMs`, for words like "last message 3 h ago" that move on their own. */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
