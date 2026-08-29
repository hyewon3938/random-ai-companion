#!/usr/bin/env bash
#
# 백업 저장소(rclone 원격 + .env의 BACKUP_REMOTE)를 한 번에 설정한다.
# 버킷과 토큰을 먼저 만들어 두고 VM에서 한 번만 실행하면 된다.
#
#   bash scripts/setup-backup-remote.sh
#
# S3 호환 스토리지면 제공자를 가리지 않는다. 물어보는 값은 6개다.
# 원격 이름, 엔드포인트 주소, rclone provider 값, 버킷 이름, Access Key ID, Secret Access Key.
# 비밀 키는 입력할 때 화면에 찍히지 않고, 이 스크립트도 어디에도 출력하지 않는다.
# 명령 인자로 넘기지 않고 표준 입력으로만 받으므로 셸 히스토리와 프로세스 목록에도 남지 않는다.
#
# 마지막에 실제로 작은 파일 하나를 올렸다 내려받고 지워서 읽기·쓰기·삭제 권한을 확인한다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

command -v rclone >/dev/null || { echo "rclone이 없다"; exit 1; }
command -v python3 >/dev/null || { echo "python3가 없다"; exit 1; }

read -rp "rclone 원격 이름 (이 VM 안에서만 쓰는 별칭): " REMOTE_NAME
[[ "$REMOTE_NAME" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "원격 이름 형식이 아니다"; exit 1; }

read -rp "엔드포인트 주소 (https:// 로 시작하는 S3 호환 주소): " ENDPOINT
[[ "$ENDPOINT" =~ ^https://[A-Za-z0-9._~-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] \
  || { echo "엔드포인트 형식이 아니다"; exit 1; }

# rclone의 S3 백엔드는 제공자마다 다르게 동작해야 하는 부분을 이 값으로 가른다.
# 목록은 rclone 문서의 s3 backend provider 항목에 있고, 없는 제공자는 Other로 둔다.
read -rp "rclone provider 값 (제공자별 이름, 모르겠으면 Other): " PROVIDER
[[ "$PROVIDER" =~ ^[A-Za-z][A-Za-z0-9]{0,31}$ ]] || { echo "provider 값 형식이 아니다"; exit 1; }

read -rp "버킷 이름: " BUCKET
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || { echo "버킷 이름 형식이 아니다"; exit 1; }

read -rp "Access Key ID: " KEY_ID
[ -n "$KEY_ID" ] || { echo "Access Key ID가 비었다"; exit 1; }

read -rsp "Secret Access Key (화면에 안 보임): " SECRET; echo
[ -n "$SECRET" ] || { echo "Secret Access Key가 비었다"; exit 1; }

CONF="$(rclone config file 2>/dev/null | tail -1)"
[ -n "$CONF" ] || CONF="$HOME/.config/rclone/rclone.conf"
mkdir -p "$(dirname "$CONF")"
touch "$CONF"
chmod 600 "$CONF"

# 기존 원격은 건드리지 않고 우리 섹션만 갈아 끼운다. 값은 인자가 아니라 환경변수로 넘긴다.
NAME="$REMOTE_NAME" PROV="$PROVIDER" END="$ENDPOINT" KID="$KEY_ID" SEC="$SECRET" CONF="$CONF" python3 <<'PY'
import os, re
conf, name = os.environ["CONF"], os.environ["NAME"]
section = "\n".join([
    f"[{name}]",
    "type = s3",
    f"provider = {os.environ['PROV']}",
    "env_auth = false",
    f"access_key_id = {os.environ['KID']}",
    f"secret_access_key = {os.environ['SEC']}",
    "region = auto",
    f"endpoint = {os.environ['END']}",
    "acl = private",
    # 버킷 범위 토큰은 버킷 목록을 못 읽는다. 있는지 확인하는 호출을 건너뛴다.
    "no_check_bucket = true",
    "",
])
text = open(conf, encoding="utf-8").read()
pattern = re.compile(rf"^\[{re.escape(name)}\]\n(?:(?!^\[).*\n?)*", re.MULTILINE)
text = pattern.sub("", text)
if text and not text.endswith("\n"):
    text += "\n"
open(conf, "w", encoding="utf-8").write(text.rstrip("\n") + "\n\n" + section if text.strip() else section)
print(f"[setup] rclone 원격 {name} 기록: {conf}")
PY
unset SECRET

# .env에는 비밀이 아닌 대상 주소만 넣는다.
REMOTE_TARGET="$REMOTE_NAME:$BUCKET"
ENV_FILE="$ENV_FILE" LINE="BACKUP_REMOTE=$REMOTE_TARGET" python3 <<'PY'
import os
path, line = os.environ["ENV_FILE"], os.environ["LINE"]
lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
for i, l in enumerate(lines):
    if l.startswith("BACKUP_REMOTE="):
        lines[i] = line
        break
else:
    lines.append(line)
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("[setup] .env의 BACKUP_REMOTE 갱신")
PY

echo "[setup] 왕복 확인 중..."
PROBE="$(mktemp)"
trap 'rm -f "$PROBE" "$PROBE.back"' EXIT
date -Iseconds > "$PROBE"
rclone copyto "$PROBE" "$REMOTE_TARGET/.setup-probe"
rclone copyto "$REMOTE_TARGET/.setup-probe" "$PROBE.back"
cmp -s "$PROBE" "$PROBE.back" || { echo "내려받은 내용이 올린 것과 다르다"; exit 1; }
rclone deletefile "$REMOTE_TARGET/.setup-probe"

echo "[setup] 완료 — 올리기·내려받기·삭제 모두 확인했다 ($REMOTE_TARGET)"
