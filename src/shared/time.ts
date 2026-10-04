export function nowMs(): number {
  return Date.now();
}

export function secondsFromNow(seconds: number): number {
  return nowMs() + seconds * 1000;
}
