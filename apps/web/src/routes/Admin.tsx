import { type FormEvent, useState } from "react";
import { adminImport, ApiError, type ImportResponse } from "../api/client";
import { Button } from "../design/Button";
import { Card } from "../design/Card";
import { TextInput } from "../design/TextInput";

const MESSAGES: Record<string, string> = {
  unauthorized: "비밀번호가 올바르지 않습니다.",
  invalid_csv: "CSV에 오류가 있어 아무것도 반영하지 않았습니다.",
  invalid_request: "파일을 확인해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
  missing_api_url: "사이트 설정이 완료되지 않았습니다.",
};

function downloadCsv(content: string): void {
  // Excel needs a BOM to read UTF-8 Korean without mojibake.
  const blob = new Blob([`﻿${content}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "참가자_코드.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function Admin() {
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [regenerate, setRegenerate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [details, setDetails] = useState<string[]>([]);
  const [result, setResult] = useState<ImportResponse | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (file === null || password === "" || loading) return;
    setLoading(true);
    setError(undefined);
    setDetails([]);
    setResult(null);
    try {
      const response = await adminImport(password, file, regenerate);
      setResult(response);
      downloadCsv(response.codesCsv);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(MESSAGES[caught.code] ?? MESSAGES.server_error);
        setDetails(caught.details ?? []);
      } else {
        setError(MESSAGES.network_error);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col px-lg py-xxl">
      <h1 className="type-heading-xl text-ink">매칭 데이터 업로드</h1>

      <div className="mt-xl">
        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-lg">
            <TextInput
              label="관리자 비밀번호"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />

            <div className="flex flex-col gap-xs">
              <label htmlFor="csv" className="type-body-strong text-ink">
                매칭 CSV
              </label>
              <input
                id="csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="type-body-sm rounded-md border border-dashed border-hairline bg-surface-card p-lg text-body"
                required
              />
              <p className="type-caption-md text-mute">
                컬럼: 부, 시간, 장소, 조, 남성 이름/생년월일/연락처/이메일,
                여성 이름/생년월일/연락처/이메일
              </p>
            </div>

            <label className="type-body-sm flex items-start gap-sm text-body">
              <input
                type="checkbox"
                checked={regenerate}
                onChange={(event) => setRegenerate(event.target.checked)}
                className="mt-1"
              />
              <span>
                전원 코드 재발급
                <span className="block text-error">
                  체크하면 이미 나눠준 코드가 모두 무효가 됩니다.
                </span>
              </span>
            </label>

            <Button
              type="submit"
              fullWidth
              disabled={file === null || password === ""}
              loading={loading}
              loadingText="업로드 중…"
            >
              업로드
            </Button>

            {error !== undefined && (
              <div role="alert" className="type-body-sm text-error">
                <p>{error}</p>
                {details.length > 0 && (
                  <ul className="mt-sm list-disc pl-lg">
                    {details.map((detail) => <li key={detail}>{detail}</li>)}
                  </ul>
                )}
              </div>
            )}
          </form>
        </Card>
      </div>

      {result !== null && (
        <div className="mt-xl">
          <Card>
            <h2 className="type-heading-lg text-ink">업로드 완료</h2>
            <ul className="type-body-md mt-lg flex flex-col gap-xs text-body">
              <li>참가자 신규 {result.participants.created}명</li>
              <li>참가자 갱신 {result.participants.updated}명</li>
              <li>매칭 {result.matches}건</li>
            </ul>

            <p className="type-body-sm-strong mt-xl rounded-md bg-surface-card px-lg py-md text-error">
              코드 CSV가 다운로드되었습니다. 평문 코드는 지금 이 파일에만
              있습니다. 서버에는 해시만 남아 다시 볼 수 없으니 반드시
              보관해주세요.
            </p>

            {result.warnings.length > 0 && (
              <>
                <h3 className="type-body-strong mt-xl text-ink">경고</h3>
                <ul className="type-body-sm mt-sm list-disc pl-lg text-mute">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-xl">
              <Button
                variant="secondary"
                fullWidth
                onClick={() => downloadCsv(result.codesCsv)}
              >
                코드 CSV 다시 받기
              </Button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}
