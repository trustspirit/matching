import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LookupResponse, MatchView } from "@shared/types.ts";
import { Badge } from "../design/Badge";
import { Button } from "../design/Button";
import { Card } from "../design/Card";
import { clearResult, loadResult } from "../lib/session";

function InfoRow({ label, value, muted = false }: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-lg">
      <span className="type-caption-md text-mute">{label}</span>
      <span className={`type-heading-md ${muted ? "text-ash" : "text-ink"}`}>
        {value}
      </span>
    </div>
  );
}

function MatchCard({ match }: { match: MatchView }) {
  return (
    <Card>
      <Badge>{match.session}</Badge>

      <p className="type-caption-md mt-xl text-mute">상대방</p>
      <h2 className="type-display-lg mt-xxs text-ink">{match.partnerName}</h2>

      <hr className="my-xl border-0 border-t border-hairline" />

      <div className="flex flex-col gap-md">
        <InfoRow label="시간" value={match.timeRange} />
        <InfoRow label="장소" value={match.venue} />
        <InfoRow
          label="조"
          value={match.team ?? "조 배정 예정"}
          muted={match.team === null}
        />
      </div>

      <p className="type-body-sm-strong mt-xl rounded-md bg-surface-card px-lg py-md text-ink">
        {match.arriveBy}까지 {match.venue}에 도착해주세요.
      </p>
    </Card>
  );
}

export function Result() {
  const navigate = useNavigate();
  const [result, setResult] = useState<LookupResponse | null>(null);

  useEffect(() => {
    const stored = loadResult();
    // A direct visit or a reload after the tab was closed has nothing to show.
    if (stored === null) navigate("/", { replace: true });
    else setResult(stored);
  }, [navigate]);

  if (result === null) return null;

  return (
    <main className="mx-auto flex w-full max-w-[480px] flex-col px-lg py-xxl">
      <h1 className="type-heading-xl text-ink">{result.displayName}님,</h1>
      <p className="type-display-lg text-ink">이렇게 만나요</p>

      <div className="mt-xxl flex flex-col gap-xl">
        {result.matches.length === 0
          ? (
            <Card>
              <p className="type-heading-md text-ink">등록된 매칭 정보가 없습니다.</p>
              <p className="type-body-sm mt-md text-mute">
                운영진에게 문의해주세요.
              </p>
            </Card>
          )
          : result.matches.map((match) => (
            <MatchCard
              key={`${match.session}-${match.venue}-${match.partnerName}`}
              match={match}
            />
          ))}
      </div>

      <div className="mt-xxl">
        <Button
          variant="tertiary"
          fullWidth
          onClick={() => {
            clearResult();
            navigate("/", { replace: true });
          }}
        >
          다시 조회
        </Button>
      </div>
    </main>
  );
}
