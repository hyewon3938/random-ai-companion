#!/usr/bin/env bash
#
# 백업본에서 DB를 되살려 원본과 맞는지 대조한다. 사람이 손으로 실행한다.
#   scripts/restore-db.sh --list              올라가 있는 백업 목록
#   scripts/restore-db.sh                     recent/의 가장 최근 것을 복원
#   scripts/restore-db.sh --object daily/companion-2026-08-29.db.zst
#
# 내려받아 압축을 풀고, 컨테이너 안에서 무결성·외래키·표별 행 수를 읽은 뒤,
# 백업을 뜰 때 로그에 남은 같은 회차의 값과 하나씩 맞춰 본다. 하나라도 어긋나면
# 종료 코드 1이다. 복원한 파일은 지우지 않고 남겨 두므로 직접 열어 볼 수 있다.
#
# 운영 DB는 건드리지 않는다. 컨테이너 안에서도 읽기 전용으로만 연다.
#
# GNU coreutils와 docker·rclone·zstd·python3를 쓰므로 리눅스 호스트 전용이다.

set -euo pipefail
export TZ=Asia/Seoul
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTAINER="${BACKUP_CONTAINER:-random-ai-companion}"
ENV_FILE="$PROJECT_DIR/.env"
LOG_FILE="${BACKUP_LOG_DIR:-$PROJECT_DIR/logs}/backup.log"
OUT_DIR="${BACKUP_RESTORE_DIR:-$(dirname "$PROJECT_DIR")/db-restore}"

# .env에서 키 하나만 꺼낸다. 값은 어디에도 출력하지 않는다.
env_val() {
  [ -f "$ENV_FILE" ] || return 0
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null \
    | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" \
    || true
}

BACKUP_REMOTE="${BACKUP_REMOTE:-$(env_val BACKUP_REMOTE)}"
BACKUP_REMOTE="${BACKUP_REMOTE%/}"

die() { echo "중단: $1" >&2; exit 1; }

[ -n "$BACKUP_REMOTE" ] || die "BACKUP_REMOTE가 비어 있다"
case "$BACKUP_REMOTE" in
  *:?*) ;;
  *) die "BACKUP_REMOTE 형식이 <remote>:<bucket>이 아니다" ;;
esac

OBJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      for tier in recent daily weekly; do
        echo "[$tier]"
        rclone lsl "$BACKUP_REMOTE/$tier" 2>/dev/null | sort -k4 || true
      done
      exit 0
      ;;
    --object) OBJECT="${2:-}"; shift 2 ;;
    *) die "모르는 인자: $1" ;;
  esac
done

# 대상을 고르지 않았으면 recent/에서 이름이 가장 늦은 것을 쓴다(이름에 시각이 들어 있다).
if [ -z "$OBJECT" ]; then
  OBJECT="recent/$(rclone lsf "$BACKUP_REMOTE/recent" 2>/dev/null | sort | tail -1)"
  [ "$OBJECT" != "recent/" ] || die "recent/에 백업이 없다"
fi

NAME="$(basename "$OBJECT")"
# companion-20260829-1400.db.zst 에서 회차 표시만 뽑는다. 로그에서 원본 값을 찾을 때 쓴다.
STAMP="$(echo "$NAME" | sed -n 's/^companion-\(.*\)\.db\.zst$/\1/p')"
WORK="$OUT_DIR/$STAMP"
RESTORED="$WORK/companion.db"
IN_CONTAINER="/tmp/companion-restore-$$.db"

mkdir -p "$WORK"
cleanup() {
  docker exec "$CONTAINER" rm -f \
    "$IN_CONTAINER" "$IN_CONTAINER-shm" "$IN_CONTAINER-wal" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "대상: $BACKUP_REMOTE/$OBJECT"

# 1) 내려받아 압축을 푼다
rclone copyto "$BACKUP_REMOTE/$OBJECT" "$WORK/$NAME"
zstd -d -q -f -o "$RESTORED" "$WORK/$NAME"
echo "복원: $RESTORED ($(stat -c %s "$RESTORED") bytes)"

# 2) SQLite 파일이 맞는지부터 본다. 아니면 다음 단계가 엉뚱한 오류를 낸다
head -c 15 "$RESTORED" | grep -q '^SQLite format 3$' || die "SQLite 파일이 아니다"

# 3) 컨테이너 안에서 읽어 무결성·외래키·표별 행 수를 받는다.
#    검사에 걸린 파일도 결과는 찍고 나가므로, 여기서 죽지 않고 아래 요약까지 간다.
docker cp "$RESTORED" "$CONTAINER:$IN_CONTAINER" >/dev/null
set +e
RESTORED_REPORT=$(docker exec "$CONTAINER" npx tsx src/tools/backup-db.ts --check "$IN_CONTAINER" | tail -1)
set -e
case "$RESTORED_REPORT" in
  \{*) ;;
  *) die "검사 결과를 읽지 못했다 — 위에 찍힌 오류를 볼 것(파일이 깨졌을 수 있다)" ;;
esac

# 4) 백업을 뜰 때 남은 같은 회차의 값을 로그에서 찾아 하나씩 맞춘다
SOURCE_REPORT=$(STAMP="$STAMP" LOG="$LOG_FILE" python3 <<'PY'
import os, re, sys
stamp, path = os.environ["STAMP"], os.environ["LOG"]
found, hit = False, ""
for line in open(path, encoding="utf-8", errors="replace") if os.path.exists(path) else []:
    if f"=== backup start ({stamp}) ===" in line:
        found = True
    elif found and " snapshot " in line:
        hit = line.split(" snapshot ", 1)[1].strip()
        break
    elif found and "=== backup" in line:
        break
print(hit)
PY
)

RESTORED_REPORT="$RESTORED_REPORT" SOURCE_REPORT="$SOURCE_REPORT" python3 <<'PY'
import json, os, sys

restored = json.loads(os.environ["RESTORED_REPORT"])
raw = os.environ["SOURCE_REPORT"].strip()
source = json.loads(raw) if raw else None

fails = []
print()
print("복원본 검사")
print(f"  user_version         {restored['userVersion']}")
print(f"  integrity_check      {restored['integrity']}")
print(f"  foreign_key_check    {restored['foreignKeyViolations']}")
print(f"  전체 행 수           {restored['totalRows']}")
print(f"  표 개수              {len(restored['tables'])}")

if restored["integrity"] != "ok":
    fails.append(f"integrity_check가 ok가 아니다: {restored['integrity']}")
if restored["foreignKeyViolations"] != 0:
    fails.append(f"외래키 위반 {restored['foreignKeyViolations']}건")

if source is None:
    print()
    print("원본 대조를 건너뛴다 — 백업 로그에서 이 회차의 기록을 찾지 못했다.")
else:
    print()
    print("원본 대조 (백업을 뜬 시점의 값)")
    for key in ("userVersion", "integrity", "foreignKeyViolations", "totalRows"):
        a, b = source.get(key), restored.get(key)
        mark = "일치" if a == b else f"불일치 {a} -> {b}"
        print(f"  {key:<20} {mark}")
        if a != b:
            fails.append(f"{key}가 원본과 다르다: {a} -> {b}")

    st, rt = source.get("tables", {}), restored.get("tables", {})
    diff = [(t, st.get(t), rt.get(t)) for t in sorted(set(st) | set(rt)) if st.get(t) != rt.get(t)]
    print(f"  표별 행 수           {'전부 일치' if not diff else '어긋난 표 ' + str(len(diff)) + '개'} (표 {len(st)}개)")
    for t, a, b in diff:
        print(f"    {t}: {a} -> {b}")
        fails.append(f"{t} 행 수가 원본과 다르다: {a} -> {b}")

print()
if fails:
    print("복원 리허설 실패")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("복원 리허설 통과")
PY
