import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatCode, isValidCode, normalizeCode } from "@shared/code.ts";
import { ApiError, lookup } from "../api/client";
import { Button } from "../design/Button";
import { TextInput } from "../design/TextInput";
import { saveResult } from "../lib/session";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "이름 또는 코드가 올바르지 않습니다.",
  too_many_attempts: "시도가 너무 많습니다. 1분 후 다시 시도해주세요.",
  invalid_request: "입력값을 확인해주세요.",
  server_error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  missing_api_url: "사이트 설정이 완료되지 않았습니다. 관리자에게 문의해주세요.",
};

export function Login() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const canSubmit = name.trim() !== "" && isValidCode(code);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await lookup(name.trim(), normalizeCode(code));
      saveResult(result);
      navigate("/result");
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : "network_error";
      setError(MESSAGES[code] ?? MESSAGES.network_error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center px-lg py-xxl">
      <div className="w-full max-w-[480px] rounded-lg bg-canvas p-xxl">
        <p className="type-caption-md flex items-center gap-sm text-mute">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-primary"
          />
          랜덤 소개팅
        </p>

        <h1 className="type-display-lg mt-lg text-ink">내 자리 확인하기</h1>
        <p className="type-body-md mt-md text-mute">
          이름과 전달받은 코드를 입력해주세요.
        </p>

        <form onSubmit={handleSubmit} className="mt-xl flex flex-col gap-lg">
          <TextInput
            label="이름"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            placeholder="김효준"
            required
          />
          <TextInput
            label="코드"
            value={code}
            // Reformatting on every keystroke keeps the hyphen in place without
            // fighting the user's cursor, because the value is fully derived.
            onChange={(event) => setCode(formatCode(event.target.value))}
            placeholder="K7M-2QX"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={7}
            error={error}
            required
          />
          <Button type="submit" fullWidth disabled={!canSubmit} loading={loading}>
            확인하기
          </Button>
        </form>
      </div>
    </main>
  );
}
