# 成长岛运行手册

正式运行由一个 Go 进程提供页面、API 和私有媒体，SQLite、照片、录音与历史素材放在本机持久磁盘。生产运行需要应用二进制、前端构建文件、`ffprobe` 和 HTTPS 入口，不需要 Node.js。

本手册提供部署步骤和本机验证方法，不代表已经配置生产服务器、证书或网络入口。按本次确认范围，不提供备份、恢复或真机验收流程。

## 构建发布目录

在源码根目录安装锁定依赖并执行检查：

```sh
npm ci
go mod download
npm run verify
npm run release
```

`release` 单独进行类型检查、前端构建与 Go 构建。它生成新的 `.local/releases/<提交号>-<时间>-<系统>-<架构>/`，已有目录不会被覆盖。工作区包含未提交变更时，版本带 `-dirty`，不能把它当作对应 Git 提交的原样构建。

可以指定目标平台与发布目录根路径：

```sh
npm run release -- --goos linux --goarch amd64 --output-root /tmp/island-releases
```

跨平台构建不等于已经在该平台运行验证。`release.json` 保存完整提交号、是否含未提交变更、构建时间、平台、文件校验值和迁移文件校验值；二进制的 `version` 子命令无需读取配置或数据库。

发布目录包含：

```text
island                  # Windows 目标为 island.exe
web/                    # 本次独立构建的静态页面
deploy/                 # 部署配置示例
operations.md           # 本手册
release.json            # 版本与文件校验值
```

基础建表脚本和受控图标、形象、饰品嵌入在二进制中。首次启动将受控素材安装到 `assets_directory`；已有素材标识的字节不同会拒绝启动，不能用新内容覆盖历史素材标识。

## 安装到一台 Linux 主机

以下以具有 systemd 的 Linux 为例。先安装能够正常执行的 `ffprobe` 与 Caddy，确认目标 CPU 架构与构建产物一致。示例使用 `/srv/island`，不把数据库放在同步盘、共享网络盘或前端公开目录。

```text
/srv/island/
  releases/<release-name>/
  current -> releases/<release-name>
  config/app.yaml
  data/island.db
  data/media/
  data/assets/
  data/tmp/
```

由服务器维护者创建专用非特权用户及目录，将完整发布目录复制到 `releases/`，再将 `current` 指向该发布目录。`releases/` 与 `config/` 由维护者管理，应用只需读取；`data/` 归 `island` 用户所有，并授予 `0700` 权限。配置文件可设为维护者所有、`island` 组可读、权限 `0640`。

首次安装的命令示例，`release_name` 与来源路径需替换为本次真实产物；已有用户或目录时检查现状后跳过相应创建步骤：

```sh
release_name='替换为实际发布目录名'
sudo useradd --system --home-dir /srv/island --shell /usr/sbin/nologin island
sudo install -d -m 0755 /srv/island /srv/island/releases
sudo install -d -o root -g island -m 0750 /srv/island/config
sudo install -d -o island -g island -m 0700 /srv/island/data
sudo cp -R "/实际产物所在目录/$release_name" /srv/island/releases/
sudo ln -s "releases/$release_name" /srv/island/current
sudo install -o root -g island -m 0640 /srv/island/current/deploy/app.production.example.yaml /srv/island/config/app.yaml
```

将 `deploy/app.production.example.yaml` 复制为 `/srv/island/config/app.yaml`，修改：

- `public_origin`：真实 HTTPS 来源，包含必要端口，不含路径或末尾斜线。
- `ffprobe_path`：主机上实际的 `ffprobe` 绝对路径。
- 所有目录路径：若采用不同安装位置，一并调整。

HTTP Origin 校验严格匹配 `public_origin`；不能将其设为 Go 内部监听地址而让用户从另一域名访问。生产配置使用 HTTPS，应用因此设置 Secure Cookie。

## 空安装与账户初始化

先在新数据库执行基础建表，再交互初始化唯一账户：

```sh
sudo -u island /srv/island/current/island version
sudo -u island /srv/island/current/island migrate -config /srv/island/config/app.yaml
sudo -u island /srv/island/current/island init -config /srv/island/config/app.yaml
```

初始化依次读取用户名、姓名、登录密码及确认、管理密码及确认。终端隐藏密码；密码不能放进命令参数。重复初始化会拒绝，初始余额为零，不导入演示任务、成绩、订单或浏览器数据。

两种密码默认 10–128 个 Unicode 码点。用户名初始化后不可修改；姓名与密码也可通过已解锁的网页管理界面维护。网页退出管理会撤销管理授权，再次进入需要重新输入管理密码；修改任一密码后所有登录会话失效。

## HTTPS 与常驻进程

将 `deploy/island.service` 安装为 `/etc/systemd/system/island.service`，确保其中的路径和用户与实际安装一致。示例只允许应用向 `/srv/island/data` 写入，停服等待时间为 120 秒，覆盖默认 90 秒上传期限；若调整上传期限，同时调整停服等待时间。

将 `deploy/Caddyfile` 中的主机名替换为与 `public_origin` 相同的真实域名，再把该站点块合并到 `/etc/caddy/Caddyfile`，保留其他已有站点。Caddy 将所有请求代理给 `127.0.0.1:8080`，不直接公开媒体或数据库目录。

```sh
sudo systemd-analyze verify /etc/systemd/system/island.service
sudo systemctl daemon-reload
sudo systemctl enable --now island
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy 的域名站点会启用自动 HTTPS；实际签发仍取决于域名解析、入口端口与证书条件，家庭内网入口应使用设备信任的证书方案。配置方式见 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https) 和 [反向代理指令](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。服务进程配置依据 [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 与 [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。

启动后检查 `/health/live` 与 `/health/ready`，再从真实入口完成登录、进入管理、创建任务、打卡和读取页面。健康接口成功只说明依赖可用，不能代替业务验证。

## 忘记密码

拥有服务器维护权限的人可以重置指定密码：

```sh
sudo -u island /srv/island/current/island reset-password -kind login -config /srv/island/config/app.yaml
sudo -u island /srv/island/current/island reset-password -kind management -config /srv/island/config/app.yaml
```

命令交互读取新密码及确认，并撤销全部会话。它不改变用户名、姓名、余额或业务记录。不提供邮件、短信或网页“忘记密码”入口。

## 开发阶段的数据库初始化

当前阶段不考虑旧数据升级，结构变化直接反映在基础建表脚本中。使用新的数据库和数据目录，按上面的 `migrate`、`init` 步骤初始化，再启动服务并验证登录、读取和写入。

`migrate` 保留为显式建库命令；建表 SQL 与版本记录在同一事务提交，失败时不记录成功。应用启动只检查 schema，不自动改库。已有数据库的版本或脚本校验与程序不匹配时仍会拒绝启动；此阶段没有升级旧库的转换脚本，不通过删除版本记录绕过检查。

## 媒体清理与日常检查

服务启动后运行媒体清理，每小时检查一次。未关联上传及解除引用文件默认 24 小时后物理清理；解除引用后立即不能读取。仍关联有效记录的媒体长期保留。清理失败会记录并重试，重启可继续处理已经标记的删除；素材目录不参与媒体清理。

孤儿清理仅处理服务生成的上传临时文件和 UUID `.media` 文件。`media_directory`、`temp_directory` 不得设置为数据库所在目录，包括指向该目录的符号链接；配置检查会拒绝这种设置。可以按示例将数据库放在 `data/island.db`，将上传分别放在 `data/media/` 和 `data/tmp/`，无需事先创建这些新目录。

不要手工删除 `.db-wal`、`.db-shm`、尚未核对的媒体文件或历史素材。可检查持久化磁盘剩余空间与应用日志；业务余额需要通过流水核对，不能直接修改钱包数字掩盖问题。

```sh
sudo systemctl status island
sudo journalctl -u island --since '30 minutes ago'
df -h /srv/island/data
```

已安装 SQLite 命令行工具时，可用只读连接检查数据库结构和账务求和：

```sh
sudo -u island sqlite3 -readonly /srv/island/data/island.db '
PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT coins - COALESCE((SELECT SUM(coin_delta) FROM wallet_entries), 0) AS coin_difference,
       diamonds - COALESCE((SELECT SUM(diamond_delta) FROM wallet_entries), 0) AS diamond_difference
FROM wallets WHERE account_id = 1;
'
```

正常结果依次为 `ok`、没有外键违规行、余额差值 `0|0`。非零差值或外键违规需要调查实际交易与日志；检查命令不会修复或覆写数据。`df` 只报告容量事实，不能证明数据库与媒体文件一致。

日志记录请求 ID、中文事件名和操作结果，不记录密码、Cookie 或完整家庭文字。排障时保留错误码、请求 ID 与发生时间，避免复制凭据或媒体内容。

| 现象 | 检查与处理 |
|---|---|
| `ORIGIN_INVALID` | 比较浏览器访问的来源与配置 `public_origin`，检查 HTTPS 域名和端口。 |
| `SESSION_REQUIRED` | 重新登录；密码修改、重置、退出或会话到期都会使旧登录失效。 |
| `MANAGEMENT_REQUIRED` | 重新输入管理密码；退出管理或授权到期后原页面不再有写权限。 |
| `DATABASE_BUSY` | 检查是否有另一应用或维护命令持有写事务；保留原请求重试，不新建第二笔交易。 |
| `STORAGE_UNAVAILABLE` | 检查磁盘空间、目录权限与文件系统状态；故障未解决前不要反复新建提交。 |
| 启动报结构版本不匹配 | 核对配置和程序版本；当前开发结构以新数据库初始化为准，不提供旧库升级。 |
| `ffprobe` 就绪检查失败 | 核对路径、执行权限与该账户能否运行 `ffprobe -version`。 |
| 素材标识内容冲突 | 保留持久化旧素材，为新内容提供新的版本标识。 |
| 写入结果未知 | 页面使用原幂等键核对；确认成功后的加载失败只重试读取。 |

当前提供的 Caddy、systemd 文件是部署示例。生产 HTTPS、服务器权限和真实网络入口须在实际安装时检查；本次自动化与本机验证不替代这些运行环境事实。
