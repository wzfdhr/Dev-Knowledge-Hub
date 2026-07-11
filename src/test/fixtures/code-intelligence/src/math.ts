import { clamp } from "./util";

export interface Range {
  min: number;
  max: number;
}

export type Operation = (left: number, right: number) => number;

export class Calculator {
  add(left: number, right: number): number {
    return add(clamp(left, 0, 100), right);
  }
}

export function add(left: number, right: number): number {
  return left + right;
}

export const VERSION = "1.0.0";
