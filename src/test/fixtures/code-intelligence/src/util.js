export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
