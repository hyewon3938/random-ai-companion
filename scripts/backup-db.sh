#!/usr/bin/env bash
#
# 운영 DB를 VM 밖으로 올린다. 호스트 크론이 6시간마다 실행한다.
#   crontab: 0 5,11,17,23 * * * /path/to/scripts/backup-db.sh   # UTC 기준 (= KST 14/20/02/08시)
#
# 컨테이너 안에서 SQLite 온라인 백업으로 일관된 스냅샷을 뜨고(src/tools/backup-db.ts),
# 호스트가 그 파일을 꺼내 압축한 뒤 오브젝트 스토리지로 올린다. 이미지를 바꾸지 않고
# 상시 프로세스도 늘리지 않는다.
#
# 보존은 3단이다. 6시간 스냅샷은 recent/에 7일, 하루 한 개는 daily/에 30일,
# 주 한 개는 weekly/에 26주. 승격은 오늘·이번 주 몫이 아직 없을 때만 하므로,
# 실행을 한 번 걸러도 다음 실행이 알아서 메운다.
#
# 설정은 프로젝트 .env에서 필요한 키만 읽는다(파일 전체를 소싱하지 않는다).
#   BACKUP_REMOTE        rclone 원격과 버킷 (형식: <remote>:<bucket>)
#   SLACK_BOT_TOKEN      실패 알림·주간 요약에 쓴다. 없으면 알림만 건너뛴다
#   SLACK_TRACE_CHANNEL  알림을 보낼 채널
#
# GNU coreutils(stat -c, date -Iseconds)와 docker·rclone·zstd·flock을 쓰므로 리눅스 호스트 전용이다.

set -euo pipefail
export TZ=Asia/Seoul
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTAINER="${BACKUP_CONTAINER:-random-ai-companion}"
ENV_FILE="$PROJECT_DIR/.env"
LOG_DIR="${BACKUP_LOG_DIR:-$PROJECT_DIR/logs}"
LOG_FILE="$LOG_DIR/backup.log"
STATE_DIR="$LOG_DIR/backup-state"

KEEP_RECENT_DAYS=7
KEEP_DAILY_DAYS=30
KEEP_WEEKLY_DAYS=182

STAMP=$(date +%Y%m%d-%H%M)
DATE=$(date +%Y-%m-%d)
WEEK=$(date +%G-W%V)

mkdir -p "$LOG_DIR" "$STATE_DIR"

# .env에서 키 하나만 꺼낸다. 값은 어디에도 출력하지 않는다.
env_val() {
  [ -f "$ENV_FILE" ] || return 0
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null \
    | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" \
    || true
}

BACKUP_REMOTE="${BACKUP_REMOTE:-$(env_val BACKUP_REMOTE)}"
SLACK_TOKEN="${SLACK_BOT_TOKEN:-$(env_val SLACK_BOT_TOKEN)}"
SLACK_CHANNEL="${SLACK_TRACE_CHANNEL:-$(env_val SLACK_TRACE_CHANNEL)}"

notify() {
  local text="$1"
  [ -n "$SLACK_TOKEN" ] && [ -n "$SLACK_CHANNEL" ] || return 0
  local payload
  payload=$(CH="$SLACK_CHANNEL" TX="$text" python3 -c \
    'import json,os; print(json.dumps({"channel": os.environ["CH"], "text": os.environ["TX"]}))')
  curl -sS -m 20 -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_TOKEN" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$payload" >/dev/null 2>&1 || true
}

# 시작 전에 멈추는 경우에도 알림은 나가야 한다. 크론 메일만 남으면 아무도 못 본다.
die() {
  echo "[$(date -Iseconds)] 중단: $1" >&2
  notify ":rotating_light: DB 백업 중단 ($STAMP) — $1"
  exit 1
}

# 컨테이너가 만든 파일은 root 소유라 호스트에서 지울 수 없다. 지우는 것도 컨테이너에 맡긴다.
WORK=$(mktemp -d)
IN_CONTAINER="/tmp/companion-backup-$STAMP.db"
cleanup() {
  rm -rf "$WORK"
  # 검사하려고 열 때 -shm·-wal이 함께 생긴다. 본체만 지우면 그 둘이 매 실행 쌓인다.
  docker exec "$CONTAINER" rm -f \
    "$IN_CONTAINER" "$IN_CONTAINER-shm" "$IN_CONTAINER-wal" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 원격에 그 이름의 객체가 이미 있는지 본다. 폴더 자체가 없으면 없는 것으로 친다.
remote_has() {
  local dir="$1" name="$2"
  [ -n "$(rclone lsf "$dir" --include "$name" 2>/dev/null || true)" ]
}

run_backup() {
  echo "[$(date -Iseconds)] === backup start ($STAMP) ==="

  # 삭제가 원격 루트를 향하지 않게 막는다. 버킷 이름이 빠진 remote: 형태면 여기서 멈춘다.
  BACKUP_REMOTE="${BACKUP_REMOTE%/}"
  [ -n "$BACKUP_REMOTE" ] || die "BACKUP_REMOTE가 비어 있다"
  case "$BACKUP_REMOTE" in
    *:?*) ;;
    *) die "BACKUP_REMOTE 형식이 <remote>:<bucket>이 아니다" ;;
  esac

  # 1) 컨테이너 안에서 스냅샷을 뜨고 그 자리에서 검사한다(무결성·외래키·표별 행 수)
  local report
  report=$(docker exec "$CONTAINER" npx tsx src/tools/backup-db.ts "$IN_CONTAINER" | tail -1)
  echo "[$(date -Iseconds)] snapshot $report"

  # 2) 호스트로 꺼내 압축한다
  docker cp "$CONTAINER:$IN_CONTAINER" "$WORK/companion.db" >/dev/null
  zstd -19 -q -o "$WORK/companion.db.zst" "$WORK/companion.db"
  local raw packed
  raw=$(stat -c %s "$WORK/companion.db")
  packed=$(stat -c %s "$WORK/companion.db.zst")
  [ "$packed" -gt 1024 ] || die "압축본이 너무 작다 ($packed bytes)"
  echo "[$(date -Iseconds)] compressed $raw -> $packed bytes"

  # 3) 올린다
  local object="$BACKUP_REMOTE/recent/companion-$STAMP.db.zst"
  rclone copyto "$WORK/companion.db.zst" "$object"
  echo "[$(date -Iseconds)] uploaded $object"

  # 4) 오늘 몫·이번 주 몫이 아직 없으면 원격 안에서 복사해 승격한다
  if ! remote_has "$BACKUP_REMOTE/daily" "companion-$DATE.db.zst"; then
    rclone copyto "$object" "$BACKUP_REMOTE/daily/companion-$DATE.db.zst"
    echo "[$(date -Iseconds)] promoted daily $DATE"
  fi
  if ! remote_has "$BACKUP_REMOTE/weekly" "companion-$WEEK.db.zst"; then
    rclone copyto "$object" "$BACKUP_REMOTE/weekly/companion-$WEEK.db.zst"
    echo "[$(date -Iseconds)] promoted weekly $WEEK"
  fi

  # 5) 보존 기간이 지난 것을 지운다. 대상은 언제나 우리 접두어 아래다
  rclone delete --min-age "${KEEP_RECENT_DAYS}d" "$BACKUP_REMOTE/recent" || true
  rclone delete --min-age "${KEEP_DAILY_DAYS}d" "$BACKUP_REMOTE/daily" || true
  rclone delete --min-age "${KEEP_WEEKLY_DAYS}d" "$BACKUP_REMOTE/weekly" || true

  # 6) 주 1회 정상 요약. 크론이 조용히 멈추면 이 요약이 끊기는 것으로 드러난다
  local marker="$STATE_DIR/summary-$WEEK"
  if [ ! -e "$marker" ]; then
    local total
    total=$(rclone size "$BACKUP_REMOTE" 2>/dev/null | tr '\n' ' ' || echo "집계 실패")
    notify ":white_check_mark: DB 백업 주간 요약 — 마지막 성공 $(date '+%m/%d %H:%M') · $total"
    : > "$marker"
    find "$STATE_DIR" -name 'summary-*' -mtime +60 -delete 2>/dev/null || true
  fi

  echo "[$(date -Iseconds)] === backup ok ==="
}

exec 9>"$LOG_DIR/.backup.lock"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] 앞 실행이 아직 돌고 있어 건너뛴다" >> "$LOG_FILE"
  exit 0
fi

if ! run_backup >> "$LOG_FILE" 2>&1; then
  notify ":rotating_light: DB 백업 실패 ($STAMP). VM의 백업 로그를 확인해야 한다."
  exit 1
fi
