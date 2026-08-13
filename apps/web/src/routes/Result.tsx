import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatKst } from "@shared/revealTime.ts";
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

/**
 * Stands in for something the server did not send yet. The blur is the whole
 * point: an empty space reads as "no partner assigned", while a shape you
 * cannot quite make out reads as "there is something here, later".
 *
 * aria-hidden because there is nothing to read -- the sentence under the card
 * says the same thing in words, which is what a screen reader should get.
 */
function Withheld({ size }: { size: "name" | "row" }) {
  return (
    <span
      aria-hidden
      className={`select-none text-ash blur-[6px] ${
        size === "name" ? "type-display-lg" : "type-heading-md"
      }`}
    >
      ●●●
    </span>
  );
}

function MatchCard({ match }: { match: MatchView }) {
  // The server sends no name at all until the session opens, so this is the
  // only signal the screen has -- and the only one it needs.
  const locked = match.partnerName === null;

  return (
    <Card>
      <Badge>{match.session}</Badge>

      <p className="type-caption-md mt-xl text-mute">상대방</p>
      {locked
        ? (
          <h2 className="mt-xxs">
            <Withheld size="name" />
            <span className="sr-only">아직 공개되지 않았습니다</span>
          </h2>
        )
        : <h2 className="type-display-lg mt-xxs text-ink">{match.partnerName}</h2>}

      <hr className="my-xl border-0 border-t border-hairline" />

      {/* Everything in this card describes the person named above it, 조
          included. The viewer's own 조 is stated once at the top of the page
          instead: repeating it here is what made the two read as one. */}
      <div className="flex flex-col gap-md">
        <InfoRow label="시간" value={match.timeRange} />
        <InfoRow label="장소" value={match.venue} />
        {/* Time and place stay visible while the partner is hidden: they are
            what gets someone to the right room on time, and they give away
            nobody. */}
        {locked
          ? (
            <div className="flex items-baseline justify-between gap-lg">
              <span className="type-caption-md text-mute">조</span>
              <Withheld size="row" />
            </div>
          )
          : (
            <InfoRow
              label="조"
              value={match.partnerTeam ?? "조 배정 예정"}
              muted={match.partnerTeam === null}
            />
          )}
      </div>

      <p className="type-body-sm-strong mt-xl rounded-md bg-surface-card px-lg py-md text-ink">
        {locked
          ? match.revealAt === null
            ? "상대방은 아직 공개 전입니다. 잠시 후 다시 조회해주세요."
            : `상대방은 ${formatKst(match.revealAt)}에 공개됩니다. ` +
              "그때 다시 조회해주세요."
          : `${match.arriveBy}까지 ${match.venue}에 도착해주세요.`}
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

  // Every match carries the same value -- it is read off the participant, not
  // the pairing -- so the first one that has it speaks for all of them.
  const myTeam = result.matches.find((m) => m.team !== null)?.team ?? null;

  return (
    <main className="mx-auto flex w-full max-w-[480px] flex-col px-lg py-xxl">
      <h1 className="type-heading-xl text-ink">{result.displayName}님,</h1>
      <p className="type-display-lg text-ink">이렇게 만나요</p>
      {/* 조 belongs to the person, so the viewer's own is the same on every
          match. Stated once here, quietly, so the cards below are free to be
          entirely about the other person. */}
      {myTeam !== null && (
        <p className="type-caption-md mt-sm text-mute">내 조 · {myTeam}</p>
      )}

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
              key={`${match.session}-${match.venue}`}
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
