"use client";

import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

import styles from "./login.module.css";

export const CODE_LENGTH = 6;

type Props = {
  digits: string[];
  onChange: (next: string[]) => void;
  invalid: boolean;
  disabled: boolean;
};

/**
 * 인증 앱 6자리 입력칸(보드 W1b2 의 네모 6개).
 * 칸을 옮기는 일은 모두 입력·키·붙여넣기 이벤트 안에서 바로 한다 — 화면이 그려진 뒤 자동으로 도는 코드(useEffect)는 쓰지 않는다.
 */
export function CodeInput({ digits, onChange, invalid, disabled }: Props) {
  // 칸 6개의 실제 DOM 을 잡아 둔다. 숫자를 넣으면 다음 칸으로, 지우면 앞 칸으로 커서를 옮기는 데 쓴다.
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  // 한 칸에 글자가 들어왔을 때: 숫자 하나만 남기고 다음 칸으로 넘어간다.
  function handleInput(index: number, raw: string) {
    const digit = raw.replace(/\D/g, "").slice(-1);
    const next = digits.map((d, i) => (i === index ? digit : d));
    onChange(next);
    if (digit !== "" && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
  }

  // 빈 칸에서 지우기를 누르면 앞 칸을 지우고 그리로 간다(사람들이 기대하는 동작).
  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Backspace" || digits[index] !== "" || index === 0) return;
    event.preventDefault();
    onChange(digits.map((d, i) => (i === index - 1 ? "" : d)));
    boxes.current[index - 1]?.focus();
  }

  // 인증 앱에서 6자리를 통째로 복사해 붙여넣으면 여섯 칸에 나눠 넣는다.
  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, CODE_LENGTH);
    if (pasted === "") return;
    event.preventDefault();
    onChange(Array.from({ length: CODE_LENGTH }, (_, i) => pasted[i] ?? ""));
    boxes.current[Math.min(pasted.length, CODE_LENGTH - 1)]?.focus();
  }

  return (
    <div className={styles.codeRow} role="group" aria-label="인증 코드 6자리">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            boxes.current[index] = el;
          }}
          className={invalid ? `${styles.codeBox} ${styles.codeBoxError}` : styles.codeBox}
          value={digit}
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={1}
          aria-label={`${index + 1}번째 숫자`}
          aria-invalid={invalid}
          disabled={disabled}
          autoFocus={index === 0}
          onChange={(e) => handleInput(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
        />
      ))}
    </div>
  );
}
