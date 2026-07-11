export function original(): string {
  return "original";
}

export class Worker {
  run(): string {
    return "run";
  }
}

export const toolkit = {
  localMethod(): string {
    return "method";
  }
};
