import { readFileSync } from "node:fs";
import { VmafError } from "../../../shared/analysis/quality/vmaf.ts";
const sleep = () => new Promise<void>((r) => setTimeout(r, 10));
export function processStartTicks(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : fields[19];
  } catch {
    return null;
  }
}
/** Recovery never starts another execution while a durably-owned old supervisor lives. */
export async function stopOwnedNative(process: {
  pid: number;
  startTicks: string;
  bootId: string;
}) {
  if (globalThis.process.platform !== "linux") return;
  if (
    !Number.isSafeInteger(process.pid) ||
    process.pid < 1 ||
    typeof process.startTicks !== "string" ||
    !/^\d+$/.test(process.startTicks) ||
    typeof process.bootId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(process.bootId)
  )
    throw new VmafError(
      "stop-uncertain",
      "Durable native ownership witness is invalid",
    );
  if (
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !==
    process.bootId
  )
    return;
  if (processStartTicks(process.pid) !== process.startTicks) return;
  try {
    globalThis.process.kill(-process.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const until = Date.now() + 2000;
  while (processStartTicks(process.pid) === process.startTicks) {
    if (Date.now() > until)
      throw new VmafError(
        "stop-uncertain",
        "Previous native process did not exit",
      );
    await sleep();
  }
}
