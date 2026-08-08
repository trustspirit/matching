import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AdminMatchRow, AdminParticipantRow } from "@shared/types.ts";
import { adminData, adminVerify, ApiError } from "../api/client";
import { Button } from "../design/Button";
import { Card } from "../design/Card";
import { TextInput } from "../design/TextInput";
import { CsvTab } from "./admin/CsvTab";
import { MatchesTab } from "./admin/MatchesTab";
import { ParticipantsTab } from "./admin/ParticipantsTab";

const MESSAGES: Record<string, string> = {
  unauthorized: "비밀번호가 올바르지 않습니다.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
  missing_api_url: "사이트 설정이 완료되지 않았습니다.",
  too_many_attempts: "시도가 너무 많습니다. 잠시 후 다시 시도해주세요.",
};

type Tab = "matches" | "participants" | "csv";

const TABS: { key: Tab; label: string }[] = [
  { key: "matches", label: "매칭" },
  { key: "participants", label: "참가자" },
  { key: "csv", label: "CSV" },
];

export function Admin() {
  const [password, setPassword] = useState("");
  // Screen-switching flag only. There is no session: the password stays in
  // memory and is re-sent with every request.
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("matches");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [matches, setMatches] = useState<AdminMatchRow[]>([]);
  const [participants, setParticipants] = useState<AdminParticipantRow[]>([]);

  const reload = useCallback(async () => {
    try {
      const m = await adminData<{ matches: AdminMatchRow[] }>(
        password,
        "list_matches",
      );
      const p = await adminData<{ participants: AdminParticipantRow[] }>(
        password,
        "list_participants",
      );
      setMatches(m.matches);
      setParticipants(p.participants);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(MESSAGES[caught.code] ?? MESSAGES.server_error);
        if (caught.code === "unauthorized") setAuthed(false);
      } else {
        setError(MESSAGES.network_error);
      }
    }
  }, [password]);

  useEffect(() => {
    if (authed) void reload();
  }, [authed, reload]);

  async function handleEnter(event: FormEvent) {
    event.preventDefault();
    if (password === "" || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      await adminVerify(password);
      setAuthed(true);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(MESSAGES[caught.code] ?? MESSAGES.server_error);
      } else {
        setError(MESSAGES.network_error);
      }
    } finally {
      setLoading(false);
    }
  }

  if (!authed) {
    return (
      <main className="mx-auto flex w-full max-w-[640px] flex-col px-lg py-xxl">
        <h1 className="type-heading-xl text-ink">매칭 데이터 관리</h1>
        <div className="mt-xl">
          <Card>
            <form onSubmit={handleEnter} className="flex flex-col gap-lg">
              <TextInput
                label="관리자 비밀번호"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
              <Button
                type="submit"
                fullWidth
                disabled={password === ""}
                loading={loading}
                loadingText="확인 중…"
              >
                들어가기
              </Button>
              {error !== undefined && (
                <p role="alert" className="type-body-sm text-error">{error}</p>
              )}
            </form>
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[900px] flex-col px-lg py-xxl">
      <h1 className="type-heading-xl text-ink">매칭 데이터 관리</h1>

      <div role="tablist" className="mt-xl flex flex-wrap gap-xs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={[
              "type-body-strong rounded-md px-lg py-md",
              tab === key
                ? "bg-surface-dark text-on-primary"
                : "bg-secondary-bg text-ink",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-lg text-error">{error}</p>
      )}

      <div className="mt-xl">
        {tab === "matches" && (
          <MatchesTab
            password={password}
            matches={matches}
            participants={participants}
            onChanged={() => void reload()}
          />
        )}
        {tab === "participants" && (
          <ParticipantsTab
            password={password}
            participants={participants}
            onChanged={() => void reload()}
          />
        )}
        {tab === "csv" && (
          <CsvTab
            password={password}
            matchCount={matches.length}
            onImported={() => void reload()}
          />
        )}
      </div>
    </main>
  );
}
