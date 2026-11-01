# 模块备份

Loon → Surge 转换模块的最后一份可用版本（作者后续已对源模块加密，转换产物可能不可用）。

## 内容

| 文件 | 原目录 | 文件数 | 日期 |
|---|---|---|---|
| `iKeLee-20261101.tar.gz` | `iKeLee/` | 274 | 2026-10-02 |
| `sooyaaabo-20261101.tar.gz` | `sooyaaabo/` | 91 | 2026-10-02 |

## 恢复

```bash
tar -xzf backup/iKeLee-20261101.tar.gz
tar -xzf backup/sooyaaabo-20261101.tar.gz
```

解压后得到 `iKeLee/` 和 `sooyaaabo/` 两个目录。

## 历史

这些目录曾在 commit `6464204` 被删除，又于 `b8fff87` 恢复，
最后于本次提交重新打包归档并移出仓库根目录。

需要旧版本也可以直接从 git 历史取：

```bash
git checkout b8fff87 -- iKeLee sooyaaabo
```
