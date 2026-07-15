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
  "resticSnapshotId": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "databaseArchiveSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "volumeArchives": ["snapshots.tgz", "repositories.tgz", "sources.tgz", "artifacts.tgz"],
  "volumeArchiveSha256": {
    "snapshots": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "repositories": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "sources": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "artifacts": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "volumeFileCounts": {
    "snapshots": 1,
    "repositories": 1,
    "sources": 1,
    "artifacts": 1
  },
  "productionVolumeTouched": false,
  "restoredSnapshotCount": 1,
  "pgRestoreListValidated": true,
  "ephemeralDatabaseRestored": true,
  "healthCheckPassed": true,
  "artifactContentVerifiedCount": 8,
  "databaseStats": {
    "workspaceCount": 1,
    "userCount": 1,
    "projectCount": 2,
    "projectMemberCount": 1,
    "snapshotCount": 1,
    "releaseCount": 3,
    "releaseChannelCount": 1,
    "artifactCount": 8
  },
  "integrity": {
    "orphanedReleases": 0,
    "orphanedReleaseChannels": 0,
    "crossWorkspaceProjectMembers": 0,
    "projectMembersWithoutWorkspaceMembership": 0,
    "orphanedArtifacts": 0
  }
}
```

验收时必须验证 `result=success`、`productionVolumeTouched=false`，且 `volumeArchives`
中的 `snapshots.tgz`、`repositories.tgz`、`sources.tgz`、`artifacts.tgz` 齐全。恢复演练还必须
真实恢复临时 PostgreSQL、校验 release/build/snapshot/repository/channel 一致性、项目权限和 artifact
引用，并逐条按 `storageKey` 校验 artifact 文件路径、JSON 与内容 SHA-256。随后启动临时应用完成健康检查；
对应字段均为 `true`，`artifactContentVerifiedCount` 必须等于 `databaseStats.artifactCount`，`integrity`
各项均为 `0`。`resticSnapshotId` 必须是 restic 返回的完整 64 位快照 ID，并与备份或恢复日志对应；
`startedAt` 和 `finishedAt` 必须是严格 UTC ISO 时间，且结束时间不得早于开始时间。记录不得包含
Restic 密码、OSS/RAM 凭据、数据库 URL、`DEVKH_MASTER_KEY`、源文件内容或数据库转储。

GitHub `container-smoke` 使用临时本地 Restic 仓库执行同一套演练，并将该 JSON 作为
`recovery-evidence` artifact 留存。CI 会先写入一组不含真实凭据的代表 workspace、成员、项目、
快照、release channel 和 artifact，并要求所有数据库计数及四卷文件计数大于 `0`；空库不能通过。
CI 在成功时删除临时仓库、恢复容器和外层 Compose 项目；失败时会保留临时仓库、恢复现场和 Compose 状态供取证，
并继续上传已生成的 `recovery-evidence` artifact。CI runner 回收前，值班人员应从日志和 artifact 记录
失败原因；不得把失败现场误标为一次成功演练。
