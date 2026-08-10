import { type FormEvent, useState } from "react";
import { adminImport, ApiError, type ImportResponse } from "../../api/client";
import { Button } from "../../design/Button";
import { Card } from "../../design/Card";
import { ConfirmDialog } from "../../design/ConfirmDialog";

const MESSAGES: Record<string, string> = {
  unauthorized: "비밀번호가 올바르지 않습니다.",
  invalid_csv: "CSV에 오류가 있어 아무것도 반영하지 않았습니다.",
  invalid_request: "파일을 확인해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
  missing_api_url: "사이트 설정이 완료되지 않았습니다.",
  too_many_attempts: "시도가 너무 많습니다. 잠시 후 다시 시도해주세요.",
};

function downloadCsv(content: string): void {
  // Excel needs a BOM to read UTF-8 Korean without mojibake.
  const blob = new Blob([`﻿${content}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "참가자_코드.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

interface CsvTabProps {
  token: string;
  /** Rows that this upload would delete. Zero means a first-time import. */
  matchCount: number;
  onImported: () => void;
}

export function CsvTab({ token, matchCount, onImported }: CsvTabProps) {
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [details, setDetails] = useState<string[]>([]);
  const [result, setResult] = useState<ImportResponse | null>(null);

  // The confirmation only appears once there is something to lose.
  const needsConfirm = matchCount > 0;
  const canSubmit = file !== null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || loading) return;
    if (needsConfirm) {
      setConfirming(true);
      return;
    }
    void upload();
  }

  async function upload() {
    if (file === null || loading) return;
    setConfirming(false);
    setLoading(true);
    setError(undefined);
    setDetails([]);
    setResult(null);
    try {
      const response = await adminImport(token, file, false);
      setResult(response);
      downloadCsv(response.codesCsv);
      onImported();
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
    <>
      {confirming && (
        <ConfirmDialog
          title="기존 매칭을 모두 교체합니다"
          confirmLabel="업로드"
          busy={loading}
          onConfirm={() => void upload()}
          onCancel={() => setConfirming(false)}
          body={
            <>
              <p>
                현재 <strong>{matchCount}건</strong>의 매칭이 등록되어 있습니다.
                업로드하면 이 {matchCount}건이 전부 삭제되고 CSV 내용으로
                교체됩니다.
              </p>
              <p className="mt-md text-error">
                한 건만 고칠 때는 업로드하지 말고 매칭 탭에서 그 행을
                수정하세요.
              </p>
            </>
          }
        />
      )}

      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-lg">

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
              <br />
              조는 남성·여성 각각 1개까지 둘 수 있습니다. '조' 컬럼이 2개면
              앞쪽이 남성, 뒤쪽이 여성으로 읽히고, '남성 조'/'여성 조'로
              이름을 붙이면 순서와 무관하게 인식됩니다.
            </p>
          </div>



          <Button
            type="submit"
            fullWidth
            disabled={!canSubmit}
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
    </>
  );
}
