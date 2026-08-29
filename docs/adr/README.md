# 설계 판단 기록 (ADR)

되돌리기 어려운 설계 판단을 한 건씩 남긴다. 포맷은 Michael Nygard 형식(상태·맥락·결정·대안·결과)이고, 새 기록은 [template.md](template.md)를 복사해서 쓴다.

`Accepted` 상태의 기록은 고치지 않는다. 판단이 바뀌면 새 번호로 기록을 하나 더 만들고, 옛 기록의 상태만 `Superseded by ADR-NNNN`으로 바꾼다.

| 번호 | 제목 | 상태 |
| --- | --- | --- |
| [0001](0001-memory-schema-v1-migration.md) | 기억 구조 스키마를 한 번에 다시 만들어 옮기기 | Accepted |
| [0002](0002-user-authored-character-creation.md) | 캐릭터 생성을 유저 입력 방식으로 바꾸고 현대 일상으로 한정하기 | Accepted |
| [0003](0003-memory-three-items-relationship-columns.md) | 기억을 세 항목으로 통합하고 관계는 컬럼으로 분리하기 | Accepted |
| [0004](0004-preference-disclosure-and-user-preferences.md) | 유저 선호를 캐릭터에게 공개하고 저장 자리를 세 갈래로 나누기 | Accepted |
| [0005](0005-memory-schema-v4-migration.md) | 기억 스키마를 v4로 옮기고 생성 시점 기억을 쓰기 규칙으로 지키기 | Accepted |
| [0006](0006-llm-call-log-storage.md) | 모델 호출 원본을 표 둘에 나눠 담고 본문만 90일 뒤 지우기 | Accepted |
| [0007](0007-keep-sqlite-single-file.md) | SQLite 파일 하나와 단일 VM 구성을 유지하기 | Accepted |
| [0008](0008-offsite-db-snapshot-backup.md) | DB를 6시간마다 스냅샷으로 떠서 VM 밖에 보관하기 | Accepted |
| [0009](0009-slack-feedback-polling.md) | 슬랙 채널에 남긴 표시를 폴링으로 모아 표 하나에 쌓기 | Accepted |
