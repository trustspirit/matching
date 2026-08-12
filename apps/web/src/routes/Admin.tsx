import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AdminMatchRow, AdminParticipantRow } from "@shared/types.ts";
import { adminData, adminLogin, adminLogout, ApiError } from "../api/client";
import {
  clearAdminToken,
  loadAdminToken,
  saveAdminToken,
} from "../lib/adminSession";
import { Button } from "../design/Button";
import { Card } from "../design/Card";
import { SkeletonRows } from "../design/SkeletonRows";
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
  // The token is the session. It is restored from localStorage on mount so a
  // reload does not send the operator back to the gate.
  const [token, setToken] = useState<string | null>(() => loadAdminToken());
  const [tab, setTab] = useState<Tab>("matches");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [matches, setMatches] = useState<AdminMatchRow[]>([]);
  const [participants, setParticipants] = useState<AdminParticipantRow[]>([]);
  // Seeded from the restored token: a reload with a stored session starts
  // fetching immediately, so the very first paint must already be the
  // placeholder rather than an empty table that fills in a moment later.
  const [dataLoading, setDataLoading] = useState(() => loadAdminToken() !== null);

  const reload = useCallback(async () => {
    if (token === null) return;
    setDataLoading(true);
    try {
      const m = await adminData<{ matches: AdminMatchRow[] }>(
        token,
        "list_matches",
      );
      const p = await adminData<{ participants: AdminParticipantRow[] }>(
        token,
        "list_participants",
      );
      setMatches(m.matches);
      setParticipants(p.participants);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(MESSAGES[caught.code] ?? MESSAGES.server_error);
        // Expired or revoked elsewhere; drop it and fall back to the gate.
        if (caught.code === "unauthorized") {
          clearAdminToken();
          setToken(null);
        }
      } else {
        setError(MESSAGES.network_error);
      }
    } finally {
      setDataLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token !== null) void reload();
  }, [token, reload]);

  async function handleEnter(event: FormEvent) {
    event.preventDefault();
    if (password === "" || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const issued = await adminLogin(password);
      saveAdminToken(issued);
      setToken(issued);
      // The password is not needed again; the token carries the session.
      setPassword("");
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

  if (token === null) {
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

  async function handleLogout(): Promise<void> {
    // Narrowed by the `token === null` early return above, but TypeScript
    // cannot see that from inside a nested function declaration.
    if (token !== null) await adminLogout(token);
    clearAdminToken();
    setToken(null);
    setMatches([]);
    setParticipants([]);
    setDataLoading(false);
  }

  // "Nothing on screen yet" rather than "no rows exist": an event with zero
  // matches must still get the real empty state, not a permanent skeleton --
  // dataLoading going false is what ends it.
  const hasData = matches.length > 0 || participants.length > 0;

  return (
    // Wider from lg because the participant row is a real table: eight columns
    // and four per-row actions need about 1050px before the email column is
    // squeezed out of existence. 900px stays the cap below lg, where the row is
    // a stacked card and the extra width would only stretch the reading line.
    <main className="mx-auto flex w-full max-w-[900px] flex-col px-lg py-xxl lg:max-w-[1200px]">
      <h1 className="type-heading-xl text-ink">매칭 데이터 관리</h1>

      <div className="mt-xl flex flex-wrap items-center gap-xs">
        {/* A segmented control: one track holding a single highlight that moves
            between the tabs. Each tab used to carry its own filled pill, which
            at this gap read as one continuous shape rather than a choice
            between three. Only the selected tab has a fill now, so what moves
            is the highlight. */}
        <div
          role="tablist"
          className="inline-flex rounded-lg bg-secondary-bg p-xxs"
        >
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={[
                "type-body-strong rounded-lg px-lg py-sm transition-colors",
                tab === key
                  ? "bg-surface-dark text-on-primary"
                  // Muted rather than full ink: an unselected tab that is as
                  // dark as the selected label makes the highlight ambiguous.
                  : "text-mute",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-md">
          {/* A refresh keeps the table on screen, so the only sign it is
              happening belongs up here, out of the data's way. */}
          {dataLoading && hasData && (
            <span role="status" className="type-caption-md text-mute">
              불러오는 중…
            </span>
          )}
          <Button
            type="button"
            variant="tertiary"
            onClick={() => void handleLogout()}
          >
            로그아웃
          </Button>
        </div>
      </div>

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-lg text-error">{error}</p>
      )}

      <div className="mt-xl">
        {dataLoading && !hasData && (
          <SkeletonRows rows={tab === "csv" ? 3 : 6} />
        )}
        {(!dataLoading || hasData) && tab === "matches" && (
          <MatchesTab
            token={token}
            matches={matches}
            participants={participants}
            onChanged={() => void reload()}
          />
        )}
        {(!dataLoading || hasData) && tab === "participants" && (
          <ParticipantsTab
            token={token}
            participants={participants}
            onChanged={() => void reload()}
          />
        )}
        {(!dataLoading || hasData) && tab === "csv" && (
          <CsvTab
            token={token}
            matchCount={matches.length}
            onImported={() => void reload()}
          />
        )}
      </div>
    </main>
  );
}
