#!/usr/bin/env bash
# 从完整发布目录执行；数据库操作以服务用户运行，所有维护选择在停服前完成。
# 文案格式串来自已随包校验的本地资源。
# shellcheck disable=SC2059
set -Eeuo pipefail
source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=deploy/publish.messages.sh
source "$source_directory/deploy/publish.messages.sh"
root=/srv/island
mode=''
seed=''
origin=''
server_host=''
listen=''
confirm_reset=no
original_args=("$@")
while (($#)); do
  case "$1" in
    --root|--database|--seed|--origin|--listen|--server-host)
      (($# >= 2)) || { printf '%s\n' "$P_ARGUMENT" >&2; exit 2; }
      case "$1" in
        --root) root=$2;; --database) mode=$2;; --seed) seed=$2;;
        --origin) origin=$2;; --listen) listen=$2;; --server-host) server_host=$2;;
      esac
      shift 2;;
    --confirm-reset) confirm_reset=yes; shift;;
    --help|-h) printf '%s\n' "$P_USAGE"; exit 0;;
    *) printf '%s\n%s\n' "$P_ARGUMENT" "$P_USAGE" >&2; exit 2;;
  esac
done
[[ "$root" == /* && "$root" != / && "$root" != *[[:cntrl:]]* ]] || { printf '%s\n' "$P_PATH" >&2; exit 2; }
[[ -z "$mode" || "$mode" == auto || "$mode" == migrate || "$mode" == reset ]] || { printf '%s\n' "$P_ARGUMENT" >&2; exit 2; }
[[ -z "$seed" || "$seed" == yes || "$seed" == no ]] || { printf '%s\n' "$P_ARGUMENT" >&2; exit 2; }
# sudo 通常会清除 SSH_CONNECTION，先取出连接使用的服务器地址并通过参数传递。
if [[ -z "$server_host" && -n "${SSH_CONNECTION:-}" ]]; then
  read -r -a ssh_connection_fields <<< "$SSH_CONNECTION"
  server_host=${ssh_connection_fields[2]:-}
fi
if [[ $(id -u) != 0 ]]; then
  command -v sudo >/dev/null || { printf '%s\n' "$P_ROOT" >&2; exit 1; }
  exec sudo bash "$source_directory/deploy/publish.sh" "${original_args[@]}" --server-host "$server_host"
fi
phase=$P_PHASE_PREFLIGHT
# 保留已完成阶段的真实状态，不在数据库变更后尝试自动启动旧程序。
failed() {
  local result=$?
  local selected
  selected=$(readlink "$root/current" 2>/dev/null || true)
  printf "$P_FAILED" "$phase" "$result" "${selected:--}" >&2
  exit "$result"
}
trap failed ERR
for dependency in systemctl runuser install sha256sum curl flock cp mv ln readlink; do
  command -v "$dependency" >/dev/null || { printf "$P_DEPENDENCY" "$dependency" >&2; exit 1; }
done
(cd "$source_directory" && sha256sum -c SHA256SUMS --quiet)
# 目录先建立以便串行化发布，尚不改动数据库或服务。
install -d -m 0755 "$root"
root=$(cd -- "$root" && pwd -P)
[[ "$root" != / ]] || { printf '%s\n' "$P_PATH" >&2; exit 2; }
exec 9>"$root/.publish.lock"
flock -n 9 || { printf '%s\n' "$P_LOCK" >&2; exit 1; }
install -d -m 0755 "$root/releases"
release_name=$(basename -- "$source_directory")
destination="$root/releases/$release_name"
if [[ "$source_directory" != "$destination" ]]; then
  if [[ -e "$destination" ]]; then
    cmp -s "$source_directory/SHA256SUMS" "$destination/SHA256SUMS" || { printf '%s\n' "$P_RELEASE_EXISTS" >&2; exit 1; }
    (cd "$destination" && sha256sum -c SHA256SUMS --quiet)
  else
    staging=$(mktemp -d "$root/releases/.upload.XXXXXXXX")
    cp -a "$source_directory/." "$staging/"
    chmod -R a+rX "$staging"
    mv -- "$staging" "$destination"
  fi
fi
configuration="$root/config/app.yaml"
binary="$destination/island"
phase=$P_PHASE_CONFIG
if ! id island >/dev/null 2>&1; then
  useradd --system --home-dir "$root" --shell /usr/sbin/nologin island
fi
install -d -m 0750 -o root -g island "$root/config"
install -d -m 0700 -o island -g island "$root/data"
# YAML 双引号可以表示含空格或引号的路径，配置最终由 Go 的配置加载器校验。
yaml_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}
if [[ ! -e "$configuration" ]]; then
  if [[ -z "$listen" ]]; then
    printf '%s' "$P_LISTEN"
    IFS= read -r listen || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
    listen=${listen:-0.0.0.0:38100}
  fi
  if [[ -z "$origin" ]]; then
    default_origin=''
    if [[ -n "$server_host" ]]; then
      # IPv6 地址在 URL 中需要方括号；端口使用实际监听设置，不能使用 SSH 端口。
      origin_host=$server_host
      if [[ "$origin_host" == *:* && "$origin_host" != \[*\] ]]; then origin_host="[$origin_host]"; fi
      default_origin="http://$origin_host:${listen##*:}"
      printf "$P_ORIGIN_DEFAULT" "$default_origin"
    else
      printf '%s' "$P_ORIGIN"
    fi
    IFS= read -r origin || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
    origin=${origin:-$default_origin}
    [[ -n "$origin" ]] || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
  fi
  probe=$(command -v ffprobe) || { printf "$P_DEPENDENCY" ffprobe >&2; exit 1; }
  temporary_config=$(mktemp "$root/config/.app.XXXXXXXX")
  # 从生产模板保留时限与业务限制，只替换本次安装的地址和持久路径。
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      listen_address:*) key=listen_address; value=$listen;;
      public_origin:*) key=public_origin; value=$origin;;
      static_directory:*) key=static_directory; value="$root/current/web";;
      database_path:*) key=database_path; value="$root/data/island.db";;
      media_directory:*) key=media_directory; value="$root/data/media";;
      temp_directory:*) key=temp_directory; value="$root/data/tmp";;
      assets_directory:*) key=assets_directory; value="$root/data/assets";;
      ffprobe_path:*) key=ffprobe_path; value=$probe;;
      *) printf '%s\n' "$line"; continue;;
    esac
    printf '%s: ' "$key"; yaml_string "$value"; printf '\n'
  done < "$destination/deploy/app.production.example.yaml" > "$temporary_config"
  chown root:island "$temporary_config"
  chmod 0640 "$temporary_config"
  # 校验新配置后才安装；失败的配置不会占据正式配置路径。
  runuser -u island -- "$binary" db-status -config "$temporary_config" >/dev/null
  mv -- "$temporary_config" "$configuration"
fi
cd -- "$root"
# TSV 由 Go 生成并拒绝控制字符，避免 shell eval 或依赖额外 JSON 工具。
status=$(runuser -u island -- "$binary" db-status -config "$configuration" -format tsv)
IFS=$'\t' read -r state database account_exists demo_complete health_url probe media temporary assets public_origin <<< "$status"
[[ -n "$state" && "$database" == /* && -n "$health_url" && -n "$public_origin" ]]
case "$state" in missing|empty|pending|current|incompatible|newer) ;; *) printf '%s\n' "$P_ARGUMENT" >&2; exit 1;; esac
runuser -u island -- "$probe" -version >/dev/null
printf "$P_STATUS" "$state" "$account_exists" "$demo_complete"
if [[ -z "$mode" ]]; then
  printf '%s' "$P_MODE"
  IFS= read -r mode || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
  mode=${mode:-auto}
fi
[[ "$mode" == auto || "$mode" == migrate || "$mode" == reset ]] || { printf '%s\n' "$P_ARGUMENT" >&2; exit 2; }
if [[ "$state" == incompatible || "$state" == newer ]]; then
  [[ "$mode" == reset ]] || { printf '%s\n' "$P_INCOMPATIBLE" >&2; exit 1; }
fi
if [[ -z "$seed" ]]; then
  printf '%s' "$P_SEED"
  IFS= read -r seed || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
  seed=${seed:-no}
fi
[[ "$seed" == yes || "$seed" == no ]] || { printf '%s\n' "$P_ARGUMENT" >&2; exit 2; }
if [[ "$seed" == yes && "$account_exists" == true && "$demo_complete" != true && "$mode" != reset ]]; then
  printf '%s\n' "$P_EXISTING" >&2
  exit 1
fi
if [[ "$mode" == reset ]]; then printf "$P_RESET_INFO" "$database"; fi
if [[ "$mode" == reset && "$confirm_reset" != yes ]]; then
  printf "$P_CONFIRM" "$database"
  IFS= read -r confirmation || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
  [[ "$confirmation" == RESET ]] || { printf '%s\n' "$P_INPUT" >&2; exit 2; }
fi
# systemd 的路径规则与 shell 不同：百分号须翻倍，双引号与反斜线须转义。
unit_path() {
  local value=$1
  value=${value//\\/\\\\}; value=${value//\"/\\\"}; value=${value//%/%%}
  printf '"%s"' "$value"
}
if systemctl cat island.service >/dev/null 2>&1; then
  service_directory=$(systemctl show island.service --property=WorkingDirectory --value)
  service_user=$(systemctl show island.service --property=User --value)
  service_command=$(systemctl show island.service --property=ExecStart --value)
  if [[ "$service_directory" != "$root" || "$service_user" != island || ( "$service_command" != *"path=$root/current/island ;"* && "$service_command" != *"path=/usr/bin/env ;"* ) || "$service_command" != *"$root/current/island serve -config $configuration ;"* ]]; then
    printf '%s\n' "$P_SERVICE_MISMATCH" >&2
    exit 1
  fi
else
  unit="$root/config/island.service"
  {
    printf '[Unit]\nDescription=Little Growth Island\nAfter=network.target\n[Service]\nType=exec\nUser=island\nGroup=island\nWorkingDirectory='
    printf '%s/.' "${root//%/%%}"
    printf '\nExecStart=:/usr/bin/env '; unit_path "$root/current/island"; printf ' serve -config '; unit_path "$configuration"
    printf '\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=120s\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths='
    unit_path "$(dirname -- "$database")"; printf ' '; unit_path "$media"; printf ' '; unit_path "$temporary"; printf ' '; unit_path "$assets"
    printf '\n[Install]\nWantedBy=multi-user.target\n'
  } > "$unit"
  # ReadWritePaths 需要实际目录存在；只创建配置明确指定的持久目录。
  install -d -m 0700 -o island -g island "$(dirname -- "$database")" "$media" "$temporary" "$assets"
  systemctl link "$unit"
  systemctl daemon-reload
fi
printf "$P_PLAN" "$destination" "$mode" "$seed"
phase=$P_PHASE_STOP
systemctl stop island.service
if [[ "$mode" == reset ]]; then
  phase=$P_PHASE_RESET
  runuser -u island -- rm -f -- "$database" "$database-wal" "$database-shm"
  account_exists=false
  state=missing
fi
if [[ "$state" != current || "$mode" == migrate ]]; then
  phase=$P_PHASE_MIGRATE
  runuser -u island -- "$binary" migrate -config "$configuration"
fi
phase=$P_PHASE_SEED
if [[ "$seed" == yes ]]; then
  runuser -u island -- "$binary" seed-demo -config "$configuration"
elif [[ "$account_exists" != true ]]; then
  runuser -u island -- "$binary" init -config "$configuration"
fi
phase=$P_PHASE_START
# 同目录 rename 原子替换 current，进程只会看到完整版本。
link="$root/.current.$$"
ln -s -- "$destination" "$link"
mv -fT -- "$link" "$root/current"
systemctl enable island.service
systemctl start island.service
phase=$P_PHASE_HEALTH
curl --fail --silent --show-error --retry 10 --retry-delay 1 --retry-connrefused --retry-all-errors --connect-timeout 2 --max-time 5 "$health_url/health/live" >/dev/null
curl --fail --silent --show-error --retry 10 --retry-delay 1 --retry-connrefused --retry-all-errors --connect-timeout 2 --max-time 5 "$health_url/health/ready" >/dev/null
printf "$P_SUCCESS" "$destination" "$public_origin"
if [[ "$seed" == yes ]]; then printf '%s\n' "$P_DEMO"; fi
