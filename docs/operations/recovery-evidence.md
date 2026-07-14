# Recovery Evidence

每次恢复演练在完成后写入一个不含凭据的 JSON 记录，路径固定为
`/var/lib/devkh-backup/recovery-evidence/<UTC-timestamp>-<snapshot-id>.json`。记录由值班管理员在
`devkh-restore-drill.service` 成功后生成；失败演练不得覆盖最近一次成功记录。

```json
{
  "schemaVersion": 1,
  "operation": "restore-drill",
  "result": "success",
  "startedAt": "2026-07-14T00:00:00.000Z",
  "finishedAt": "2026-07-14T00:04:12.000Z",
  "resticSnapshotId": "abc123",
  "databaseArchiveSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "volumeArchives": ["snapshots.tgz", "repositories.tgz", "sources.tgz", "uploads.tgz", "artifacts.tgz"],
  "productionVolumeTouched": false,
  "restoredSnapshotCount": 1,
  "pgRestoreListValidated": true
}
```

验收时必须验证 `result=success`、`productionVolumeTouched=false`、四个卷归档均在
`volumeArchives` 中的 `snapshots.tgz`、`repositories.tgz`、`sources.tgz`、`uploads.tgz`、`artifacts.tgz` 齐全，`pgRestoreListValidated=true`，并将 `resticSnapshotId` 与 restic
日志对应。记录不得包含 Restic 密码、OSS/RAM 凭据、数据库 URL、`DEVKH_MASTER_KEY`、
源文件内容或数据库转储。
