import { original as renamed, Worker } from "./call-targets";
import * as targets from "./call-targets";

const worker = new Worker();
const localObject = {
  execute(): string {
    return "execute";
  }
};
interface DeclaredCallable {
  value: () => void;
}
const declaredOnly = {} as DeclaredCallable;

export function exercise(): void {
  directLocal();
  renamed();
  targets.original();
  worker.run();
  localObject.execute();
  targets.toolkit.localMethod();
  Math.max(1, 2);
  JSON.stringify({});
  declaredOnly.value();
}

function directLocal(): string {
  return "direct";
}
