import { formatPoint } from "./point.mjs";

export function greetPoint(name, point) {
  return `${name}: ${formatPoint(point)}`;
}
