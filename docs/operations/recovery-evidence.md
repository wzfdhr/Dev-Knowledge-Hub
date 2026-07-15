# Recovery Evidence

每次恢复演练在完成后写入一个不含凭据的 JSON 记录，路径固定为
`/var/lib/devkh-backup/recovery-evidence/<UTC-timestamp>-<snapshot-id>.json`。记录由值班管理员在
`devkh-restore-drill.service` 成功后生成；失败演练不得覆盖最近一次成功记录。

```json
{
  "schemaVersion": 2,
  "operation": "restore-drill",
  "result": "success",
  "startedAt": "2026-07-14T00:00:00.000Z",
  "finishedAt": "2026-07-14T00:04:12.000Z",
  "resticSnapshotId": "abc123",
  "databaseArchiveSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "volumeArchives": ["snapshots.tgz", "repositories.tgz", "sources.tgz", "artifacts.tgz"],
  "productionVolumeTouched": false,
  "restoredSnapshotCount": 1,
  "pgRestoreListValidated": true,
  "ephemeralDatabaseRestored": true,
  "healthCheckPassed": true,
  "databaseStats": {
    "workspaceCount": 1,
    "projectCount": 2,
    "releaseCount": 3,
    "artifactCount": 8
  },
  "integrity": {
    "orphanedReleases": 0,
    "crossWorkspaceProjectMembers": 0,
    "orphanedArtifacts": 0
  }
}
```

验收时必须验证 `result=success`、`productionVolumeTouched=false`，且 `volumeArchives`
中的 `snapshots.tgz`、`repositories.tgz`、`sources.tgz`、`artifacts.tgz` 齐全。恢复演练还必须
真实恢复临时 PostgreSQL、校验 release/权限/artifact 引用并启动临时应用完成健康检查；对应字段均为
`true`，`integrity` 各项均为 `0`。`resticSnapshotId` 必须与 restic 日志对应。记录不得包含
Restic 密码、OSS/RAM 凭据、数据库 URL、`DEVKH_MASTER_KEY`、源文件内容或数据库转储。

GitHub `container-smoke` 使用临时本地 Restic 仓库执行同一套演练，并将该 JSON 作为
`recovery-evidence` artifact 留存。CI 临时仓库及恢复容器在任务结束时删除。
