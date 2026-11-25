// 안드로이드 에뮬레이터를 adb 로 다루는 작은 도구 — 시연 영상 녹화(dev-demo-record-emulator.ts)가 쓴다(2026-11-25).
//
// 좌표는 추측하지 않는다: 화면 구조(uiautomator dump)에서 글자(text)·접근성 이름(content-desc)으로 요소를 찾아 그 가운데를 누른다.
// adb 는 Windows 쪽 adb.exe 를 WSL 에서 바로 부른다(전역 CLAUDE.md 「안드로이드 에뮬레이터」).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

export const ADB = process.env["ADB"] ?? "/mnt/c/Users/Lenovo/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const DEVICE = process.env["ANDROID_SERIAL"] ?? "emulator-5554";

/** adb 명령 하나를 끝까지 돌리고 표준 출력을 돌려준다 */
export function adb(args: string[], opts: { binary?: boolean; allowFail?: boolean; timeoutMs?: number } = {}): Buffer {
  const r = spawnSync(ADB, ["-s", DEVICE, ...args], { maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs });
  if (r.status !== 0 && opts.allowFail !== true) {
    throw new Error(`adb ${args.join(" ")} → ${r.status} ${String(r.stderr).slice(0, 300)}`);
  }
  return r.stdout;
}
export const shell = (cmd: string): string => adb(["shell", cmd]).toString("utf8");

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 화면 구조 ────────────────────────────────────────────────────────────────
export type UiNode = { text: string; desc: string; cls: string; checked: boolean; selected: boolean; x1: number; y1: number; x2: number; y2: number };
export const center = (n: UiNode): [number, number] => [Math.round((n.x1 + n.x2) / 2), Math.round((n.y1 + n.y2) / 2)];

/** 지금 화면의 요소 목록. 화면이 계속 움직이면(사진 전환 등) dump 가 실패할 수 있어 몇 번 다시 한다 */
export function dump(): UiNode[] {
  for (let i = 0; i < 8; i += 1) {
    // 깨진 글자가 화면에 있으면 dump 가 멈추는 일이 있어 15초에서 끊는다
    const xml = adb(["exec-out", "uiautomator", "dump", "/dev/tty"], { allowFail: true, timeoutMs: 15_000 }).toString("utf8");
    // 가끔 한 번씩 비어서 온다(토스트·키보드가 뜨는 순간 등) — 잠깐 쉬고 다시 읽는다
    if (!xml.includes("<hierarchy")) {
      spawnSync("sleep", ["0.5"]);
      continue;
    }
    const nodes: UiNode[] = [];
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
      const attr = (name: string) => {
        const v = new RegExp(`${name}="([^"]*)"`).exec(m[0]);
        return v === null ? "" : v[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#10;/g, "\n");
      };
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[0]);
      if (b === null) continue;
      nodes.push({
        text: attr("text"),
        desc: attr("content-desc"),
        cls: attr("class"),
        checked: attr("checked") === "true",
        selected: attr("selected") === "true",
        x1: Number(b[1]),
        y1: Number(b[2]),
        x2: Number(b[3]),
        y2: Number(b[4]),
      });
    }
    return nodes;
  }
  throw new Error("uiautomator dump 실패");
}

/** 글자나 접근성 이름이 맞는 요소들(문자열은 완전 일치, 정규식은 부분 일치) */
export function findAll(nodes: UiNode[], match: string | RegExp): UiNode[] {
  const ok = (s: string) => (typeof match === "string" ? s === match : match.test(s));
  return nodes.filter((n) => (ok(n.text) || ok(n.desc)) && n.x2 > n.x1 && n.y2 > n.y1);
}

/** 요소가 나올 때까지 기다린다. 화면 아래(탭바 위)까지 보이는 것만 센다 */
export async function waitFor(match: string | RegExp, timeoutMs = 20_000, opts: { maxY?: number } = {}): Promise<UiNode> {
  const until = Date.now() + timeoutMs;
  let last: UiNode[] = [];
  while (Date.now() < until) {
    last = dump();
    const hit = findAll(last, match).filter((n) => opts.maxY === undefined || n.y1 < opts.maxY);
    if (hit.length > 0) return hit[0]!;
    await sleep(400);
  }
  const seen = last.map((n) => n.text || n.desc).filter((s) => s !== "").slice(0, 40).join(" | ");
  throw new Error(`화면에서 「${String(match)}」 를 찾지 못했다 — 보이는 것: ${seen}`);
}

export function tapXY(x: number, y: number): void {
  shell(`input tap ${x} ${y}`);
}
export function tapNode(n: UiNode): void {
  const [x, y] = center(n);
  tapXY(x, y);
}
/** 찾아서 누른다 */
export async function tap(match: string | RegExp, timeoutMs = 20_000, opts: { maxY?: number } = {}): Promise<UiNode> {
  const n = await waitFor(match, timeoutMs, opts);
  tapNode(n);
  return n;
}

/** 손가락으로 천천히 끌어 올리기/내리기(dy>0 이면 아래 내용을 본다) */
export function swipe(dy: number, ms = 700, x = 540, midY = 1300): void {
  const from = Math.round(midY + dy / 2);
  const to = Math.round(midY - dy / 2);
  shell(`input swipe ${x} ${from} ${x} ${to} ${ms}`);
}

/** 영문·숫자 글자 넣기(adb input text 는 한글이 안 된다). 사람이 치듯 몇 글자씩 */
export async function typeAscii(text: string, chunk = 2, gapMs = 120): Promise<void> {
  for (let i = 0; i < text.length; i += chunk) {
    const part = text.slice(i, i + chunk).replace(/([@&()<>|;'"\\$` ])/g, "\\$1");
    shell(`input text ${part}`);
    await sleep(gapMs);
  }
}

export function key(code: string | number): void {
  shell(`input keyevent ${code}`);
}

/** 앱 안 주소로 이동(Expo Go 딥링크) */
export function openPath(path: string): void {
  shell(`am start -a android.intent.action.VIEW -d 'exp://127.0.0.1:8081/--${path}' host.exp.exponent`);
}

export function screencap(file: string): void {
  writeFileSync(file, adb(["exec-out", "screencap", "-p"], { binary: true }));
}

// ── 화면 녹화 ────────────────────────────────────────────────────────────────
// screenrecord 는 파일 하나에 최대 180초 — 장면 묶음마다 새로 시작하고 끝나면 PC 로 가져온다.
export class ScreenRecording {
  private proc: ChildProcess | null = null;
  private readonly remote: string;
  startedAt = 0;
  constructor(readonly name: string) {
    this.remote = `/sdcard/kdance-${name}.mp4`;
  }
  async start(): Promise<void> {
    adb(["shell", "rm", "-f", this.remote], { allowFail: true });
    this.proc = spawn(ADB, ["-s", DEVICE, "shell", "screenrecord", "--bit-rate", "8000000", "--time-limit", "178", this.remote], { stdio: "ignore" });
    // 녹화가 실제로 시작될 때까지(파일이 생길 때까지) 기다린 뒤 시각을 잡는다
    for (let i = 0; i < 30; i += 1) {
      await sleep(100);
      const out = adb(["shell", "ls", this.remote], { allowFail: true }).toString("utf8");
      if (out.includes(this.remote)) break;
    }
    this.startedAt = Date.now();
  }
  now(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
  /** 멈추고 PC 파일로 가져온다 */
  async stop(localFile: string): Promise<number> {
    const length = this.now();
    adb(["shell", "pkill", "-INT", "screenrecord"], { allowFail: true });
    for (let i = 0; i < 50 && this.proc !== null && this.proc.exitCode === null; i += 1) await sleep(200);
    await sleep(800);
    writeFileSync(localFile, adb(["exec-out", "cat", this.remote], { binary: true }));
    adb(["shell", "rm", "-f", this.remote], { allowFail: true });
    this.proc = null;
    return length;
  }
}

/** 입력칸(EditText) 하나를 접근성 이름(보통 칸 위 라벨과 같다)으로 찾아 누른다 */
export async function focusField(label: string | RegExp, timeoutMs = 20_000): Promise<UiNode> {
  // 키보드가 다음 칸을 가리고 있으면 누를 수 없다 — 먼저 내린다
  await hideKeyboard();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = findAll(dump(), label).filter((n) => n.cls.includes("EditText"));
    if (hit.length > 0) {
      tapNode(hit[0]!);
      await sleep(400);
      return hit[0]!;
    }
    await sleep(400);
  }
  throw new Error(`입력칸 「${String(label)}」 를 찾지 못했다`);
}

/** 한글이 섞인 글자 넣기 — Windows 클립보드에 넣으면 에뮬레이터 클립보드로 넘어온다. 그다음 붙여넣기 키 */
export async function pasteText(text: string): Promise<void> {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  spawnSync("powershell.exe", ["-NoProfile", "-Command", `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`]);
  await sleep(700);
  key(279);
}

/** 키보드가 떠 있으면 내린다(떠 있지 않을 때 뒤로 키를 누르면 화면이 뒤로 가므로 먼저 확인한다) */
export async function hideKeyboard(): Promise<void> {
  const state = shell("dumpsys input_method");
  if (/mInputShown=true/.test(state)) {
    key(4);
    await sleep(500);
  }
}

/** 칸을 눌러 들어 있던 글자를 모두 지운다(Ctrl+A → 지우기) */
export async function clearFocused(): Promise<void> {
  shell("input keycombination 113 29");
  await sleep(150);
  key(67);
  await sleep(150);
}

/** 화면에 안 보이면 조금씩 내려 가며 찾는다(아래로만). 찾으면 그 요소 */
export async function scrollTo(match: string | RegExp, opts: { maxY?: number; step?: number; tries?: number; editText?: boolean } = {}): Promise<UiNode> {
  const maxY = opts.maxY ?? 2150;
  for (let i = 0; i < (opts.tries ?? 8); i += 1) {
    const hit = findAll(dump(), match).filter((n) => n.y2 < maxY && n.y1 > 230 && (opts.editText !== true || n.cls.includes("EditText")));
    if (hit.length > 0) return hit[0]!;
    swipe(opts.step ?? 700, 600);
    await sleep(700);
  }
  throw new Error(`스크롤해도 「${String(match)}」 를 찾지 못했다`);
}
