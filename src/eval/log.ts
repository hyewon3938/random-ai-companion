// 실행 결과를 파일에 한 줄씩 쌓는다 — 기준선을 두고 비교하려면 지난 숫자가 남아 있어야 한다.
//
// DB에 넣지 않는 이유: 평가용 DB(data/eval.db)는 언제든 지우고 다시 만드는 임시 파일이라
// 결과가 같이 날아가고, 운영 DB에 넣으면 대화 데이터와 스키마가 섞인다. 저장소 루트에 두면
// 프롬프트를 고친 커밋 옆에 그날 숫자가 함께 남아서, 어느 문안으로 잰 값인지 나중에 맞출 수 있다.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const LOG_PATH = new URL("../../eval-runs.jsonl", import.meta.url);

/** 실행 한 번의 기록. */
export interface RunRecord {
  at: string;
  /** 이 숫자를 낸 프롬프트가 어느 커밋인지. */
  commit: string;
  /** 커밋되지 않은 변경이 있었는가 — true면 커밋 문안과 실제 잰 문안이 다를 수 있다. */
  dirty: boolean;
  model: string;
  cases: number;
  runs: number;
  pass: number;
  total: number;
  rate: number;
  /** 정해진 JSON 형식으로 온 답의 수. */
  json: number;
  /** 케이스별 통과 수 — "5/5" 꼴. 어느 케이스가 깎아먹는지 여기서 본다. */
  byCase: Record<string, string>;
  /** 규칙별 위반 횟수. */
  violations: Record<string, number>;
  /** 점수 밖 표시(물음표 짐작) 줄 수. */
  suspects: number;
  /** 재지 못한 케이스 — 되묻는 자리인데 질문이 안 나온 경우 등. */
  missed: number;
  /** 오늘 메모가 실려 온 횟수와, 그것을 잰 실행 횟수. 메모 케이스가 붙기 전 기록에는 없다. */
  noteHits?: number;
  noteTotal?: number;
  /** --note=로 남기는 메모. 무엇을 고치고 잰 것인지. */
  note?: string;
}

const git = (args: string[]): string => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

export const gitState = (): { commit: string; dirty: boolean } => ({
  commit: git(["rev-parse", "--short", "HEAD"]) || "unknown",
  dirty: git(["status", "--porcelain"]).length > 0,
});

export const appendRun = (record: RunRecord): void => {
  appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
};

export const readRuns = (): RunRecord[] => {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord);
};
