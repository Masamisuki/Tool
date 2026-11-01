# 模块备份

Loon → Surge 转换模块的归档（作者后续可能对源模块加密，故保留可用的最后版本）。

## 内容

| 文件 | 原目录 | 文件数 | 生成日期 |
|---|---|---|---|
| `iKeLee-20261101.tar.gz` | `iKeLee/` | 274 | 2026-11-01 |
| `sooyaaabo-20261101.tar.gz` | `sooyaaabo/` | 89 | 2026-11-01 |

## 恢复

```bash
tar -xzf backup/iKeLee-20261101.tar.gz
tar -xzf backup/sooyaaabo-20261101.tar.gz
```

解压后得到 `iKeLee/` 和 `sooyaaabo/` 两个目录。

## 历史

- `6464204` 首次删除这两个目录
- `b8fff87` 从历史恢复
- `be4b887` 打包归档，移出仓库根目录
- 本次：重新转换后更新归档（sooyaaabo 由 91 个变为 89 个，上游下架 2 个）

也可以直接从 git 历史取旧版本：

```bash
git checkout b8fff87 -- iKeLee sooyaaabo
```
