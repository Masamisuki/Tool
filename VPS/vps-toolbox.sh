#!/usr/bin/env bash
# ==============================================================================
#  VPS 常用工具箱  (vps-toolbox)
#
#  把常用的一键脚本整合成一个带菜单的入口。
#
#  用法:
#     bash vps-toolbox.sh                # 本地运行
#     curl -fsSL <地址> | bash           # 在线运行（已处理 tty，可正常交互）
#     bash <(curl -fsSL <地址>)
#
#  说明:
#     · 所有需要输入的地方都强制从 /dev/tty 读取，所以 curl|bash 也不会出错
#     · 交互式子脚本的 stdin 也从 /dev/tty 接入
#     · 每项执行完会暂停，按回车回到菜单
# ==============================================================================
set -uo pipefail

VERSION="3.29"

# 安装后的命令名
CMD_NAME="qc"
INSTALL_PATH="/usr/local/bin/${CMD_NAME}"


# BBR / TCP 调优（Eric86777/vps-tcp-tune）
NET_TUNE_URL="https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/net-tcp-tune.sh"

# aria2 磁力下载用的公共 tracker（比纯 DHT 找节点快得多）
ARIA2_TRACKERS="udp://tracker.opentrackr.org:1337/announce,udp://open.stealth.si:80/announce,udp://tracker.torrent.eu.org:451/announce,udp://exodus.desync.com:6969/announce,udp://tracker.moeking.me:6969/announce,udp://explodie.org:6969/announce"

# WARP (warp-go) —— fscarmen/warp，纯用户态实现，专治「纯 IPv6 机器没有 IPv4」
WARPGO_URL="https://gitlab.com/fscarmen/warp/-/raw/main/warp-go.sh"

# Docker 官方安装脚本
DOCKER_GET_URL="https://get.docker.com"

# emby-rp 期望版本（Emby-rp 发新版时同步更新；act_embyproxy 用它做最低版本校验）
EMBY_RP_VERSION="1.1.7"

# 自身在线地址（自安装/自更新时按顺序尝试，第一个成功即止）
# 只保留官方源和 jsDelivr：第三方加速镜像不受我们控制，内容被换也看不出来，
# 绝不能作为以 root 身份执行的脚本的下载源。
# 可用环境变量覆盖，例如：
#   SELF_URL="https://raw.githubusercontent.com/Masamisuki/Tool/main/VPS/vps-toolbox.sh" \
#     bash vps-toolbox.sh install
SELF_URLS=(
  "${SELF_URL:-https://raw.githubusercontent.com/Masamisuki/Tool/main/VPS/vps-toolbox.sh}"
  "https://cdn.jsdelivr.net/gh/Masamisuki/Tool@main/VPS/vps-toolbox.sh"
)

# 远程脚本内容标志（run_remote 用）：下载后必须包含该行才执行。
# 防的是镜像串货 / CDN 返回错误页 / 地址被换成别的东西；
# 不能防上游仓库本身被投毒（真要防那一层得 pin commit SHA）。
# key 是 run_remote 的第一个参数（显示名）；新增远程脚本时记得在这里补一行。
declare -A REMOTE_MARKERS=(
  ["net-tcp-tune"]="net-tcp-tune.log"
  ["tcpfit"]="单机 TCP 调优代理"
  ["key.sh"]="SSH Security Installer (key.sh)"
  ["warp-go.sh"]="trap cleanup_resources EXIT INT TERM"
  ["install-lite.sh"]="POSIX installer for systemd Linux and OpenWrt/procd soft routers."
  ["NodeQuality"]="LloydAsp/NodeQuality"
  ["TcpQuality"]="TcpQuality 默认入口"
  ["bbrv3"]="# Managed by Actions-bbr-v3"
  ["get-docker.sh"]="Docker Engine for Linux installation script."
  ["mmwx-install"]="# 妙妙屋X - Xray 服务器管理与订阅拼车系统 安装脚本"
  ["reinstall.sh（用法）"]="### BEGIN reinstall.sh ###"
)

# ---------------------------------------------------------------- tty 检测
# 注意：不能只用 `[ -r /dev/tty ]`，ssh 无 pty 时该判断会误判，
#       必须真正尝试打开一次。
HAVE_TTY=0
if { true < /dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

# ---------------------------------------------------------------- 颜色
if [ -t 1 ]; then   # 只在 stdout 是终端时上色，重定向/管道里不输出转义符
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; MAGENTA=$'\033[0;35m'
  BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; MAGENTA=''; BOLD=''; DIM=''; NC=''
fi

# ---------------------------------------------------------------- 基础输出
hr()    { printf '%s\n' "${DIM}──────────────────────────────────────────────────────────────${NC}"; }
info()  { printf '  %s\n' "$1"; }
dim()   { printf '  %s%s%s\n' "$DIM" "$1" "$NC"; }
ok()    { printf '  %s✔%s %s\n' "$GREEN" "$NC" "$1"; }
warn()  { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$1"; }
err()   { printf '  %s✘%s %s\n' "$RED" "$NC" "$1"; }
step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$NC"; }

# ---------------------------------------------------------------- 输入（关键）
# 优先读 /dev/tty，保证 `curl | bash` 时也能交互
# 返回非 0 表示读到 EOF（Ctrl+D），调用方应据此退出
ask() {
  local prompt="$1" __var="$2" __in=''
  if [ "$HAVE_TTY" = 1 ]; then
    if ! read -r -p "$prompt" __in < /dev/tty; then printf -v "$__var" '%s' ''; return 1; fi
  else
    if ! read -r -p "$prompt" __in; then printf -v "$__var" '%s' ''; return 1; fi
  fi
  printf -v "$__var" '%s' "$__in"
  return 0
}

pause() {
  local _dummy
  ask $'\n'"${DIM}按回车返回菜单 ...${NC}" _dummy || true
}

confirm() {
  local a
  # 默认 Y：直接回车即确认；读到 EOF（非交互/Ctrl+D）仍按取消处理。
  ask "  ${YELLOW}$1 [Y/n]: ${NC}" a || return 1
  case "$a" in
    ''|[yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# 断网 / 不可逆操作专用：不受默认 Y 影响，必须完整输入 yes 才确认；EOF 仍取消。
confirm_explicit() {
  local a
  ask "  ${YELLOW}$1（请输入 yes 确认）: ${NC}" a || return 1
  [ "$a" = "yes" ] && return 0
  return 1
}

# ---------------------------------------------------------------- root 检查
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "${YELLOW}本工具多数功能需要 root 权限。${NC}"
  if [ -f "$0" ] && [ -r "$0" ]; then
    printf '%s\n' "正在尝试用 sudo 重新运行 ..."
    # 不用 sudo -E：默认 sudoers 下普通用户没有 SETENV 权限，-E 会直接失败；
    # 同时 -E 会把调用者的 BASH_ENV / TMPDIR 等带进 root shell。
    # 自定义源只在确实设置过时单独透传。
    if [ -n "${SELF_URL:-}" ]; then
      exec sudo SELF_URL="$SELF_URL" bash "$0" "$@"
    fi
    exec sudo bash "$0" "$@"
  else
    printf '%s\n' "${RED}请用 root 运行，例如： sudo bash vps-toolbox.sh${NC}"
    exit 1
  fi
fi

# ---------------------------------------------------------------- 临时文件清理
# Ctrl+C 时各函数里的 rm 跑不到，这里兜底
# 临时目录名带本进程 PID（见 run_remote / act_flyx），trap 只清自己的，多实例并发不互删
_CLEANUP_FILES=()
_register_tmp() { _CLEANUP_FILES+=("$1"); }
_cleanup_tmp() {
  local f
  if [ "${#_CLEANUP_FILES[@]}" -gt 0 ]; then
    for f in "${_CLEANUP_FILES[@]}"; do rm -f "$f" 2>/dev/null || true; done
  fi
  rm -rf "${TMPDIR:-/tmp}"/vpstool.$$.* 2>/dev/null || true
}
trap _cleanup_tmp EXIT
trap '_cleanup_tmp; exit 130' INT TERM

# ---------------------------------------------------------------- 下载并执行
HAVE_CURL=0; command -v curl >/dev/null 2>&1 && HAVE_CURL=1
HAVE_WGET=0; command -v wget >/dev/null 2>&1 && HAVE_WGET=1

fetch() {   # fetch <url> <outfile>
  local url="$1" out="$2"
  if [ "$HAVE_CURL" = 1 ]; then
    # --max-time 是总超时：连上了但服务器不吐数据时也会退出，不会永远吊着
    curl -q -fsSL --connect-timeout 20 --max-time 120 --retry 2 --retry-delay 2 "$url" -o "$out"
  elif [ "$HAVE_WGET" = 1 ]; then
    wget -q -T 30 -t 2 -O "$out" "$url"
  else
    err "curl / wget 都没有，请先执行「1. 安装基础依赖」"
    return 1
  fi
}

# run_remote <显示名> <url> [解释器] [传给脚本的参数...]
# 下载后会按 REMOTE_MARKERS 校验内容（查不到标志行就不执行），新增脚本记得补标志。
run_remote() {
  local name="$1" url="$2" interp="${3:-bash}"; shift 3 || true
  local tmp rc=0 base dir marker
  # 用 URL 里的文件名落盘：部分脚本会读 $0 判断自身名字（例如 warp-go 的自更新）
  base="$(printf '%s' "${url%%\?*}" | sed 's|.*/||; s|[^A-Za-z0-9._-]|_|g')"
  [ -n "$base" ] || base="script.sh"
  # 临时目录名带上本进程 PID：多实例并发时 trap 只清自己的，不会删掉另一个实例的下载目录
  dir="$(mktemp -d "${TMPDIR:-/tmp}/vpstool.$$.XXXXXX")" || { err "无法创建临时目录"; return 1; }
  tmp="$dir/$base"

  step "下载 $name"
  dim "$url"
  if ! fetch "$url" "$tmp"; then
    err "下载失败（网络不通 / 地址失效 / 被墙）"
    rm -rf "$dir"; return 1
  fi
  if [ ! -s "$tmp" ]; then
    err "下载内容为空"
    rm -rf "$dir"; return 1
  fi
  # 内容校验：先拒掉 HTML 错误页（CDN/镜像返回 200 但内容不对时常见），
  # 再按 REMOTE_MARKERS 核对这就是要跑的那个脚本。
  if head -c 512 "$tmp" | grep -qiE '<!DOCTYPE|<html|404: Not Found|AccessDenied'; then
    err "下载内容是 HTML 错误页，不是脚本，拒绝执行"
    rm -rf "$dir"; return 1
  fi
  marker="${REMOTE_MARKERS[$name]:-}"
  if [ -z "$marker" ]; then
    warn "$name 未在 REMOTE_MARKERS 登记标志行，跳过内容校验（仅剩 HTML 检查）"
  fi
  if [ -n "$marker" ] && ! grep -qF -- "$marker" "$tmp"; then
    err "内容校验失败：下载到的不是 $name（缺少标志行），拒绝执行"
    rm -rf "$dir"; return 1
  fi
  ok "已下载 $(wc -c < "$tmp") 字节"

  step "执行 $name"
  dim "交互式操作请按提示直接输入；Ctrl+C 可中断"
  hr
  if [ "$HAVE_TTY" = 1 ]; then
    "$interp" "$tmp" "$@" < /dev/tty
  else
    "$interp" "$tmp" "$@"
  fi
  rc=$?
  hr
  if [ "$rc" -eq 0 ]; then ok "$name 执行完成"
  elif [ "$rc" -ge 130 ]; then warn "$name 被中断（退出码 $rc）"
  else warn "$name 退出码 $rc，请留意上方输出"; fi
  rm -rf "$dir"
  return "$rc"
}

# ================================================================ 各项功能

# CA 证书是否存在（本地信任库缺失，跟网络无关：精简镜像 / DD 后的系统常没有）
_ca_ok() {
  [ -f /etc/ssl/certs/ca-certificates.crt ] \
    || [ -f /etc/pki/tls/certs/ca-bundle.crt ] \
    || [ -f /etc/ssl/cert.pem ]
}

act_deps() {
  local missing="" c
  step "安装基础依赖：sudo curl wget ca-certificates"
  for c in sudo curl wget; do
    command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
  done
  if [ -z "$missing" ] && _ca_ok; then ok "所需命令都已存在"; return 0; fi
  [ -n "$missing" ] && info "缺少:$missing"
  _ca_ok || info "缺少: ca-certificates（缺了它所有 https 下载都会失败）"
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y $missing ca-certificates
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y $missing ca-certificates
  elif command -v yum     >/dev/null 2>&1; then yum install -y $missing ca-certificates
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache $missing ca-certificates
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm $missing ca-certificates
  elif command -v zypper  >/dev/null 2>&1; then zypper -n install $missing ca-certificates
  else err "未识别的包管理器"; return 1; fi
  for c in $missing; do
    command -v "$c" >/dev/null 2>&1 && ok "$c 安装成功" || err "$c 仍然缺失"
  done
  HAVE_CURL=0; command -v curl >/dev/null 2>&1 && HAVE_CURL=1
  HAVE_WGET=0; command -v wget >/dev/null 2>&1 && HAVE_WGET=1
}

act_timezone() {
  local tz="${1:-Asia/Shanghai}"
  step "设置时区为 $tz"
  if command -v timedatectl >/dev/null 2>&1; then
    if timedatectl set-timezone "$tz" 2>/dev/null; then
      ok "已设置：$(timedatectl show -p Timezone --value 2>/dev/null)"
    else
      err "设置失败"; return 1
    fi
  else
    ln -sf "/usr/share/zoneinfo/$tz" /etc/localtime && echo "$tz" > /etc/timezone
    ok "已设置：$(cat /etc/timezone 2>/dev/null)"
  fi
  info "当前时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
}

act_journal() {
  local f=/etc/systemd/journald.conf size="${1:-500M}"
  step "限制 journald 日志为 $size（单文件 50M）"
  if ! command -v journalctl >/dev/null 2>&1; then err "没有 systemd-journald，跳过"; return 1; fi
  info "清理前：$(journalctl --disk-usage 2>/dev/null | sed 's/^/  /')"
  journalctl --vacuum-size="$size" >/dev/null 2>&1 || true
  [ -f "$f" ] && cp -a "$f" "$f.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
  touch "$f"
  # 空文件或缺 [Journal] 段时，先补段头，否则追加的配置落在段外会被忽略
  if ! grep -qE '^\[Journal\]' "$f"; then
    # 文件非空且末尾缺换行时先补一个，避免段头粘在上一行末尾
    [ -s "$f" ] && [ -n "$(tail -c 1 "$f" 2>/dev/null)" ] && printf '\n' >> "$f"
    printf '[Journal]\n' >> "$f"
  fi
  if grep -qE '^#?\s*SystemMaxUse=' "$f"; then
    sed -i -E "s|^#?\s*SystemMaxUse=.*|SystemMaxUse=$size|" "$f"
  else
    printf 'SystemMaxUse=%s\n' "$size" >> "$f"
  fi
  if grep -qE '^#?\s*SystemMaxFileSize=' "$f"; then
    sed -i -E 's|^#?\s*SystemMaxFileSize=.*|SystemMaxFileSize=50M|' "$f"
  else
    printf 'SystemMaxFileSize=50M\n' >> "$f"
  fi
  systemctl restart systemd-journald 2>/dev/null && ok "已生效"
  info "生效配置：$(grep -E '^SystemMax(Use|FileSize)=' "$f" | tr '\n' ' ')"
  info "清理后：$(journalctl --disk-usage 2>/dev/null | sed 's/^/  /')"
}

act_bootstrap() {
  step "一键基础初始化（依赖 + 时区 + 日志限制）"
  local failed=""
  act_deps || failed="$failed 依赖"
  echo
  act_timezone || failed="$failed 时区"
  echo
  act_journal || failed="$failed 日志限制"
  echo
  if [ -n "$failed" ]; then
    warn "基础初始化部分完成，未完成：${failed# }"
  else
    ok "基础初始化完成"
  fi
}

# 把 bbr 装成 /usr/local/bin/bbr 真实命令。
# 官方做法是往 ~/.bashrc 写 alias，但 alias 必须 source 或重连 SSH 才生效，
# 所以这里额外落一个可执行文件：任何 shell、任何时刻敲 bbr 都能用。
install_bbr_cmd() {
  local dst="/usr/local/bin/bbr"
  mkdir -p /usr/local/bin 2>/dev/null || { err "无法创建 /usr/local/bin"; return 1; }
  cat > "$dst" <<'BBR_CMD_EOF'
#!/usr/bin/env bash
# bbr —— net-tcp-tune 快捷入口（由 vps-toolbox 安装）
# 等价于官方别名：
#   alias bbr="bash <(curl -q -fsSL ".../net-tcp-tune.sh?$(date +%s)")"
set -uo pipefail
URL="https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/net-tcp-tune.sh?$(date +%s)"
TMP="$(mktemp "${TMPDIR:-/tmp}/net-tcp-tune.XXXXXX.sh")"
# Ctrl+C / 中断时也要删掉临时脚本，不在 /tmp 留残留
trap 'rm -f "$TMP"' EXIT
trap 'rm -f "$TMP"; exit 130' INT TERM
if command -v curl >/dev/null 2>&1; then
  curl -q -fsSL --connect-timeout 20 --retry 2 "$URL" -o "$TMP" || { echo "下载 net-tcp-tune.sh 失败" >&2; rm -f "$TMP"; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 20 -t 2 -O "$TMP" "$URL" || { echo "下载 net-tcp-tune.sh 失败" >&2; rm -f "$TMP"; exit 1; }
else
  echo "需要 curl 或 wget，请先在工具箱里执行「1. 安装基础依赖」" >&2
  exit 1
fi
[ -s "$TMP" ] || { echo "下载内容为空" >&2; rm -f "$TMP"; exit 1; }
if head -c 512 "$TMP" | grep -qiE '<!DOCTYPE|<html|404: Not Found|AccessDenied'; then
  echo "下载内容是 HTML 错误页，不是脚本，拒绝执行" >&2; rm -f "$TMP"; exit 1
fi
if ! grep -qF -- 'net-tcp-tune.log' "$TMP"; then
  echo "内容校验失败：下载到的不是 net-tcp-tune.sh（缺少标志行），拒绝执行" >&2; rm -f "$TMP"; exit 1
fi
bash "$TMP"
rc=$?
rm -f "$TMP"
exit $rc
BBR_CMD_EOF
  chmod +x "$dst" 2>/dev/null || { err "chmod 失败"; return 1; }
  [ -s "$dst" ] || { err "写入失败"; return 1; }
  return 0
}

act_net_tune() {
  step "BBR v3 优化 —— net-tcp-tune"
  info "Eric86777/vps-tcp-tune 主脚本，带完整交互菜单"
  echo

  # 先确保 bbr 命令存在，否则用户装完敲 bbr 会 command not found；
  # 旧版 bbr 没有内容校验，检测到就重装。
  local bbr_ok=0
  if command -v bbr >/dev/null 2>&1 && grep -qF -- 'net-tcp-tune.log' "$(command -v bbr)" 2>/dev/null; then
    bbr_ok=1
  fi
  if [ "$bbr_ok" = 1 ]; then
    ok "bbr 命令已就绪：$(command -v bbr)"
  else
    if command -v bbr >/dev/null 2>&1; then info "bbr 命令是旧版（无内容校验），正在更新 ..."
    else info "先安装 bbr 快捷命令 ..."; fi
    if install_bbr_cmd; then
      ok "已安装 /usr/local/bin/bbr"
      dim "任何 shell 直接敲 bbr 即可，不需要 source"
    else
      warn "bbr 命令安装失败，但下面仍会直接运行调优脚本"
    fi
  fi
  echo

  run_remote "net-tcp-tune" "${NET_TUNE_URL}?$(date +%s)" bash

  echo
  info "以后随时输入 ${BOLD}bbr${NC} 即可再次打开调优菜单"
}

act_tcpfit() {
  step "tcpfit —— 单机 TCP 精细调优"
  info "实测推导参数，不使用抄来的固定值；交互式菜单"
  run_remote "tcpfit" \
    "https://raw.githubusercontent.com/Kylin010/tcpfit/main/tcpfit.sh?$(date +%s)" \
    bash
}

act_bbrv3() {
  step "BBRv3 内核 —— byJoey/Actions-bbr-v3（官方主线 + BBRv3 补丁）"
  info "给 Debian 12+ / Ubuntu 24.04+ 装带 BBRv3 的官方主线内核（apt 装 .deb）"
  echo

  # 只支持 Debian 12+ / Ubuntu 24.04+：先按 /etc/os-release 拦住不支持的系统，
  # 否则 dpkg 检测为空时仍会放行去跑安装脚本（非 Debian 系上必失败，还可能跑一半）。
  local osid="" osver=""
  if [ -f /etc/os-release ]; then
    osid="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n1)"
    osver="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -n1)"
  fi
  case "$osid" in
    debian)
      if [ "$(printf '%s\n%s\n' "$osver" "12" | sort -V | head -n1)" != "12" ]; then
        err "BBRv3 需要 Debian 12+，当前是 Debian ${osver:-未知}"; return 1
      fi ;;
    ubuntu)
      if [ "$(printf '%s\n%s\n' "$osver" "24.04" | sort -V | head -n1)" != "24.04" ]; then
        err "BBRv3 需要 Ubuntu 24.04+，当前是 Ubuntu ${osver:-未知}"; return 1
      fi ;;
    *) err "BBRv3 只支持 Debian 12+ / Ubuntu 24.04+，当前系统：${osid:-未知} ${osver:-}"; return 1 ;;
  esac

  local up="https://raw.githubusercontent.com/byJoey/Actions-bbr-v3/main/install.sh"

  # ---------- 检测（包名带 -joeyblog-bbrv3） ----------
  local pkgs="" running=0 installed=0
  pkgs=$(dpkg -l 2>/dev/null | awk '/^ii/ && $2 ~ /^linux-image-/ && $2 ~ /joeyblog-bbrv3/ {sub(/^linux-image-/, "", $2); print $2}')
  [ -n "$pkgs" ] && installed=1
  case "$(uname -r)" in *joeyblog-bbrv3*) running=1 ;; esac

  hr
  printf '  %s当前内核%s   : %s\n' "$DIM" "$NC" "$(uname -r)"
  if [ "$running" = 1 ]; then
    ok "BBRv3 内核【已安装，且正在运行】"
  elif [ "$installed" = 1 ]; then
    warn "BBRv3 内核【已安装，但当前没在运行】—— 需要重启"
  else
    warn "BBRv3 内核【未安装】"
  fi
  if [ -n "$pkgs" ]; then
    printf '  %s已装的包%s   :\n' "$DIM" "$NC"
    echo "$pkgs" | sed 's/^/      linux-image-/'
  fi
  printf '  %s拥塞控制%s   : %s\n' "$DIM" "$NC" "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"
  printf '  %s可用算法%s   : %s\n' "$DIM" "$NC" "$(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null)"
  printf '  %s队列规则%s   : %s\n' "$DIM" "$NC" "$(sysctl -n net.core.default_qdisc 2>/dev/null)"
  hr
  echo

  warn "上游菜单只用 1（安装/更新）和 9（卸载）"
  dim "  2-8、10-14 都别用 —— 参数一律交给 tcpfit（qc → 3）"
  dim "  原因：qdisc 会打架 / sysctl.d 文件互相覆盖 / 疯批模式与整形相反"
  echo
  dim "  装完算法名仍然是 bbr（补丁替换的是实现，没改名）"
  dim "  → tcpfit 设 bbr 时，实际跑的就是 BBRv3，零配置吻合"
  dim "  ⚠️ 装内核前确认能回退：dpkg -l | grep linux-image"
  echo

  if [ "$installed" = 1 ]; then
    ok "已安装 —— 直接进入上游菜单（不再询问）"
    echo
  else
    if ! confirm "确认执行？"; then warn "已取消"; return 0; fi
    echo
  fi

  # 走 run_remote：落盘 + 非空 + HTML 检查，不再直接管道执行。
  # 上游 install.sh 标志行已对照源码核对（# Managed by Actions-bbr-v3，2026-11-19），REMOTE_MARKERS 里已加 bbrv3。
  run_remote "bbrv3" "$up" bash

  echo
  info "后续："
  dim "  ① 装了新内核 → 重启生效: reboot"
  dim "  ② 重启后验证:        uname -r | grep joeyblog"
  dim "  ③ 再跑 tcpfit 调参数: qc → 3"
  dim "  ④ 卸载:              重跑本项 → 上游菜单选 9"
}

act_keysh() {
  step "key.sh —— SSH 安全加固（密钥登录 / 端口 / 防爆破）"
  warn "此脚本会修改 SSH 配置，请务必先确认新的登录方式可用再断开当前连接"
  if ! confirm "确认继续？"; then warn "已取消"; return 0; fi
  run_remote "key.sh" \
    "https://raw.githubusercontent.com/BeacherZ/key.sh/main/key.sh?$(date +%s)" \
    bash
}

act_embyproxy() {
  step "emby-rp —— Emby HTTPS 反代管理器（Caddy / Nginx）"
  info "自研脚本：独立反代 / 前后端分离 / 推流域名改写，多站点并存"
  echo
  dim "  仓库      https://github.com/Masamisuki/Tool/tree/main/VPS"
  dim "  形态      独立反代（整站） / 前后端分离（根路径给前端，前缀回源）"
  dim "  引擎      caddy（自动签证书） / nginx（certbot + 响应体与 Location 改写）"
  dim "  命令      emby（短） / emby-rp，装好后直接敲 emby 进菜单"
  echo

  local tmp ver="" installed=""
  # 临时文件用 mktemp 且带 PID：固定路径 /root/emby-rp.sh 在两实例并发时会互相覆盖
  tmp="$(mktemp "${TMPDIR:-/tmp}/emby-rp.$$.XXXXXX.sh")" || { err "无法创建临时文件"; return 1; }
  _register_tmp "$tmp"   # Ctrl+C 也由 EXIT/INT trap 清掉；函数正常返回时下面显式清

  # ---------- 已有安装就先把现状列出来 ----------
  if command -v emby >/dev/null 2>&1; then
    installed="$(command -v emby)"
  elif command -v emby-rp >/dev/null 2>&1; then
    installed="$(command -v emby-rp)"
  elif [ -x /usr/local/bin/emby-rp ]; then
    installed="/usr/local/bin/emby-rp"
  fi

  if [ -n "$installed" ]; then
    ok "已安装：$installed（$("$installed" --version 2>/dev/null)）"
    echo
    "$installed" list 2>/dev/null || true
    echo
    dim "  下面会拉 v${EMBY_RP_VERSION} 覆盖安装（站点与证书都保留）"
  else
    info "未安装，先拉取脚本本体（不会动系统配置）"
  fi
  echo

  # ---------- 下载 ----------
  # 脚本已搬到 Tool 仓库的 VPS/ 下，Tool 仓库没有 emby 的 tag，
  # 所以不用 jsDelivr@tag；raw 直链排第一保证拿到最新版，
  # jsDelivr@main 做备用（@main 有 12 小时缓存，版本号校验会挡住旧版）
  local want="$EMBY_RP_VERSION" ts
  ts="$(date +%s)"
  local urls=(
    "https://raw.githubusercontent.com/Masamisuki/Tool/main/VPS/emby-rp.sh?$ts"
    "https://cdn.jsdelivr.net/gh/Masamisuki/Tool@main/VPS/emby-rp.sh"
  )
  local u got=0
  for u in "${urls[@]}"; do
    dim "  下载 ${u%%\?*}"
    if ! fetch "$u" "$tmp" 2>/dev/null; then
      dim "    不通，换下一个源"
      continue
    fi
    if ! grep -q '^CMD_NAME="emby-rp"' "$tmp" 2>/dev/null; then
      dim "    内容不对，换下一个源"
      continue
    fi
    ver=$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$tmp" | head -n1)
    # 版本号比预期低（镜像缓存）就继续试下一个源
    if [ -n "$ver" ] && [ -n "$want" ] && \
       [ "$(printf '%s\n%s\n' "$ver" "$want" | sort -V | head -n1)" != "$want" ]; then
      warn "    该源给的是 v$ver，低于 v$want，换下一个源"
      continue
    fi
    got=1
    break
  done
  if [ "$got" != 1 ]; then
    err "下载失败或无可用版本（镜像可能还在缓存旧版），请稍后重试"
    dim "  手动下载：https://raw.githubusercontent.com/Masamisuki/Tool/main/VPS/emby-rp.sh"
    rm -f "$tmp"
    return 1
  fi
  ver=$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$tmp" | head -n1)
  # 不再 chmod 644：这是 root 下载的脚本，没必要让所有用户可读
  ok "脚本就绪${ver:+（v$ver）}"
  echo

  # ---------- 进菜单 ----------
  info "打开 emby-rp 菜单：新建站点 / 列表 / 自检 / 日志 / 删除 / 卸载"
  dim "  非交互环境可直接用：emby add -d 域名 -y"
  echo
  if [ "$HAVE_TTY" = 1 ]; then
    bash "$tmp" menu < /dev/tty || warn "emby-rp 非正常退出"
  else
    bash "$tmp" menu || warn "emby-rp 非正常退出"
  fi
  rm -f "$tmp"

  echo
  info "常用命令："
  dim "  emby                 打开菜单"
  dim "  emby list            列出站点"
  dim "  emby check <站点名>  连通性 / 证书自检"
  dim "  emby logs <站点名> -f 跟踪访问日志"
  dim "  emby uninstall       卸载（逐步确认）"
  dim "  emby uninstall --all 一键彻底卸载（证书/包/数据目录全清，无残留）"
  dim "  也可进菜单选 8 = 彻底卸载（等同 --all）"
  echo
  dim "  前后端分离 + 推流域写法的例子："
  dim "  emby add -d api.你的域名 -e nginx -u https://服务商API域 \\"
  dim "      --rewrite '服务商推流域=>你的推流域名' -y"
  dim "  emby add -d 你的推流域名 -e nginx -u https://服务商推流域 -y"
}

act_warpgo() {
  step "WARP (warp-go) —— 给纯 IPv6 机器加 IPv4 出口"
  info "fscarmen/warp 的 warp-go.sh；纯用户态实现，不碰内核，兼容性最好"
  echo
  dim "  适用：机器只有 IPv6，但需要 IPv4 下载东西 / 跑脚本 / 访问 IPv4-only 站点"
  dim "  装完命令：warp-go（之后直接敲 warp-go 进菜单）"
  echo
  info "  ${BOLD}菜单里选 2${NC} = 「IPv4 全局 + IPv6 优先」（推荐）"
  dim "  只加 IPv4 接口，IPv6 保持原生 —— 只有纯 IPv4 的站点才走 WARP"
  warn "不要选 3~7：那些会把 IPv6 一起劫持，原生 IPv6 性能会崩"
  echo
  warn "「全局」会改写 IPv4 默认路由，确认机器上没有别的 IPv4 配置"

  # ---------- 检测是否已经装过 ----------
  local installed=0
  if command -v warp-go >/dev/null 2>&1 || [ -x /opt/warp-go/warp-go ] || [ -d /opt/warp-go ]; then
    installed=1
  fi

  if [ "$installed" = 1 ]; then
    ok "检测到 warp-go 已安装 —— 直接执行（重新配置 / 重装）"
    [ -x /opt/warp-go/warp-go ] && dim "  程序: /opt/warp-go/warp-go"
    command -v warp-go >/dev/null 2>&1 && dim "  短命令: $(command -v warp-go)"
    echo
  else
    if ! confirm "确认继续？"; then warn "已取消"; return 0; fi
  fi

  run_remote "warp-go.sh" "$WARPGO_URL" bash

  echo
  step "验证出口"
  # set -u 下必须初始化：没有 curl/wget 时下面的分支不会给它们赋值
  local v4="" v6=""
  if [ "$HAVE_CURL" = 1 ]; then
    v4=$(curl -4 -s --max-time 10 https://ifconfig.me 2>/dev/null)
    v6=$(curl -6 -s --max-time 10 https://ifconfig.me 2>/dev/null)
  elif [ "$HAVE_WGET" = 1 ]; then
    v4=$(wget -q -4 -T 10 -t 1 -O - https://ifconfig.me 2>/dev/null)
    v6=$(wget -q -6 -T 10 -t 1 -O - https://ifconfig.me 2>/dev/null)
  fi
  if [ -n "$v4" ]; then ok "IPv4 出口: $v4      ${DIM}(应该是 Cloudflare 的地址)${NC}"
  else warn "IPv4 出口取不到 —— 检查 WARP 是否已启动"; fi
  if [ -n "$v6" ]; then ok "IPv6 出口: $v6      ${DIM}(应该还是你原来的)${NC}"
  else dim "  IPv6 出口取不到（这台可能没有 IPv6）"; fi
  echo

  if command -v warp-go >/dev/null 2>&1; then
    ok "warp-go 已就绪：$(command -v warp-go)"
  else
    dim "  没看到 warp-go 命令，重新登录 SSH 或执行 hash -r 再试"
  fi
}

# ---------------------------------------------------------------- IPv6 管理
# 实测踩过的坑（都在 7.x 内核 + 静态 /128 地址的机器上复现过）：
#   1. 不能只靠 net.ipv6.conf.all.disable_ipv6=1。某些内核里写 all 并不会
#      传播到已经存在的接口，结果 all 读出来是 1、但 eth0 仍然是 0，
#      IPv6 地址和出口完全正常。所以这里逐个接口显式设置并逐个校验。
#   2. all=1 的接口会连带把 lo 也禁掉，::1 失效；这里最后把 lo 单独开回来。
#   3. 备份放 /var/lib/vps-toolbox/，不留在 /etc/sysctl.d/（会被 sysctl --system 读走）。
#   4. 恢复时静态/DHCPv6 地址不会自己回来；检测到没地址会询问是否重启网络。

# 列出需要处理的物理/公网接口（排除 lo 和容器虚拟网卡）
_ipv6_ifs() {
  local i
  for i in $(ls /sys/class/net 2>/dev/null); do
    [ "$i" = "lo" ] && continue
    case "$i" in
      docker*|br-*|veth*|virbr*|cni*|flannel*|cali*|kube*|podman*|lxc*) continue ;;
    esac
    printf '%s\n' "$i"
  done
}

_ipv6_addrs() {
  ip -6 addr show scope global 2>/dev/null | awk '/inet6/{print $2}' | head -5
}

# 所有非 lo 接口都 disable_ipv6=1 才算真的禁用；只看 all 会误判
_ipv6_is_disabled() {
  local i v seen=0
  for i in $(_ipv6_ifs); do
    seen=1
    v=$(sysctl -n "net.ipv6.conf.${i}.disable_ipv6" 2>/dev/null)
    [ "$v" = "1" ] || return 1
  done
  [ "$seen" = 1 ] || return 1
  return 0
}

# 逐个接口设值，返回失败接口名（空=全成功）
_ipv6_apply() {
  local val="$1" i bad=""
  for i in $(_ipv6_ifs); do
    if ! sysctl -w "net.ipv6.conf.${i}.disable_ipv6=${val}" >/dev/null 2>&1; then
      bad="$bad $i"
    fi
    # sysctl -w 成功但值没落下去，也算失败
    if [ "$(sysctl -n "net.ipv6.conf.${i}.disable_ipv6" 2>/dev/null)" != "$val" ]; then
      case " $bad " in *" $i "*) ;; *) bad="$bad $i" ;; esac
    fi
  done
  sysctl -w net.ipv6.conf.lo.disable_ipv6=0 >/dev/null 2>&1
  printf '%s' "${bad# }"
  [ -z "$bad" ]
}

# 生成 /etc/sysctl.d/99-disable-ipv6.conf：显式列出每个接口
_ipv6_write_conf() {
  local i
  {
    echo "# 永久禁用 IPv6（由 vps-toolbox 生成）"
    echo "# 注意：all=1 在部分内核上不会传播到已存在的接口，所以逐个显式列出。"
    echo "net.ipv6.conf.all.disable_ipv6 = 1"
    echo "net.ipv6.conf.default.disable_ipv6 = 1"
    for i in $(_ipv6_ifs); do
      echo "net.ipv6.conf.${i}.disable_ipv6 = 1"
    done
    echo "net.ipv6.conf.lo.disable_ipv6 = 0"
  } > /etc/sysctl.d/99-disable-ipv6.conf
}

_ipv6_restore_hint() {
  echo
  local addrs
  addrs="$(_ipv6_addrs)"
  if [ -n "$addrs" ]; then
    ok "当前 IPv6 地址："
    printf '%s\n' "$addrs" | sed 's/^/    /'
    return 0
  fi
  warn "当前没有 IPv6 地址 —— 需要重新触发网络配置才会回来"
  local tool=""
  if [ -d /etc/netplan ] && ls /etc/netplan/*.yaml >/dev/null 2>&1; then
    tool="netplan";  dim "  Ubuntu(netplan):  netplan apply"
  elif [ -f /etc/network/interfaces ]; then
    tool="ifupdown"; dim "  Debian(ifupdown): systemctl restart networking"
  elif systemctl is-active --quiet systemd-networkd 2>/dev/null; then
    tool="networkd"; dim "  networkd:         systemctl restart systemd-networkd"
  fi
  dim "  然后确认：ip -6 addr show scope global"

  [ -n "$tool" ] || return 0
  echo
  if ! confirm_explicit "要现在立刻重启网络让地址回来吗？（SSH 可能断连）"; then
    info "已跳过 —— 你也可以之后手动执行上面那条命令"
    return 0
  fi
  case "$tool" in
    netplan)   netplan apply >/dev/null 2>&1 ;;
    ifupdown)  systemctl restart networking >/dev/null 2>&1 ;;
    networkd)  systemctl restart systemd-networkd >/dev/null 2>&1 ;;
  esac
  sleep 3
  addrs="$(_ipv6_addrs)"
  if [ -n "$addrs" ]; then
    ok "IPv6 地址已恢复："
    printf '%s\n' "$addrs" | sed 's/^/    /'
  else
    warn "重启网络后仍没有地址 —— 请检查商家的 IPv6 下发配置"
  fi
}

_ipv6_disable_runtime() {
  if ! confirm "确认临时禁用 IPv6？（重启后自动恢复）"; then
    info "已取消"; return 0
  fi
  sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1
  sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1
  local bad
  bad="$(_ipv6_apply 1)" || true
  echo
  if _ipv6_is_disabled; then
    ok "IPv6 已临时禁用（只改运行时，不动任何配置文件）"
    dim "  重启后自动恢复；要永久禁用请选 2"
  else
    err "仍有接口没禁掉：${bad:-未知}"
    dim "  逐个查：sysctl -a | grep 'net.ipv6.conf.*disable_ipv6'"
    return 1
  fi
  _ipv6_restore_hint
}


# 生成 systemd 服务：启动后（等网络就绪）再强制设一次。
# 只靠 /etc/sysctl.d 不够 —— 实测有的机器上 sysctl.d 应用得太早，
# 或者被网络服务/cloud-init 覆盖，重启后 eth0 又变回 disable_ipv6=0。
#
# 注意：不能把 shell 变量直接写进 ExecStart —— systemd 会自己展开 $VAR/${VAR}，
# 导致 ${d##*/} 被吃成空字符串。所以逻辑放到独立脚本里。
_ipv6_helper_path() { printf '%s' "/usr/local/libexec/disable-ipv6.sh"; }

_ipv6_write_helper() {
  local p; p="$(_ipv6_helper_path)"
  mkdir -p "$(dirname "$p")" || return 1
  cat > "$p" <<'IPV6_HELPER_EOF'
#!/bin/sh
# 由 vps-toolbox 生成：开机后把每个非 lo 接口的 IPv6 关掉。
for d in /sys/class/net/*; do
  n=${d##*/}
  [ "$n" = "lo" ] && continue
  sysctl -q -w "net.ipv6.conf.$n.disable_ipv6=1" 2>/dev/null || true
done
sysctl -q -w net.ipv6.conf.lo.disable_ipv6=0 2>/dev/null || true
exit 0
IPV6_HELPER_EOF
  chmod 755 "$p" || return 1
}

_ipv6_write_service() {
  local p; p="$(_ipv6_helper_path)"
  _ipv6_write_helper || return 1
  cat > /etc/systemd/system/disable-ipv6.service <<IPV6_SVC_EOF
[Unit]
Description=Disable IPv6 (vps-toolbox)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/sleep 3
ExecStart=${p}

[Install]
WantedBy=multi-user.target
IPV6_SVC_EOF
}

_ipv6_remove_service() {
  systemctl disable --now disable-ipv6.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/disable-ipv6.service
  rm -f "$(_ipv6_helper_path)"
  systemctl daemon-reload >/dev/null 2>&1 || true
}

# 收集 ifupdown 配置文件：主文件 + 它 source 的 interfaces.d/ 下的文件。
# 只扫被 source 的文件：没被引用的文件里写什么都不生效，报了也是误报。
_ipv6_iface_files() {
  [ -f /etc/network/interfaces ] || return 0
  printf '%s\n' /etc/network/interfaces
  if grep -qE '^[[:space:]]*source[[:space:]]+/etc/network/interfaces\.d/' /etc/network/interfaces 2>/dev/null; then
    local f
    for f in /etc/network/interfaces.d/*; do
      [ -f "$f" ] && printf '%s\n' "$f"
    done
  fi
}

# 备份并注释掉给定文件里的 inet6 static 段（恢复时把 .bak-ipv6 拷回去）。
# 只动 static 段：auto/dhcp 段留着不影响禁用，注释了反而丢配置。
# 写临时文件再 mv，避免原地改写到一半；已有备份时保留不动。
_ipv6_comment_static() {
  local f bak n
  for f in "$@"; do
    [ -f "$f" ] || continue
    bak="$f.bak-ipv6"
    if [ -f "$bak" ]; then
      dim "  已有备份，保留不动：$bak"
    else
      cp -p "$f" "$bak" || { err "备份失败：$f"; return 1; }
      dim "  已备份：$bak"
      # 本次新建的备份记下来：禁用失败/取消时只恢复这些（已有备份是旧状态，恢复会回退）
      IPV6_NEW_BAK_FILES="${IPV6_NEW_BAK_FILES:+$IPV6_NEW_BAK_FILES }$f"
    fi
    n=$(awk '$1=="iface" && $3=="inet6" && $4=="static" {c++} END{print c+0}' "$f" 2>/dev/null)
    # 从 iface ... inet6 static 起注释，到空行/下一个段落为止；auto/dhcp 段不动。
    awk '/^$|^(auto|allow-|source|mapping)/{s=0} /^iface /{s=($3=="inet6" && $4=="static")} s && NF{sub(/^/, "#")} 1' \
      "$f" > "$f.tmp-ipv6" || { err "改写失败：$f"; rm -f "$f.tmp-ipv6"; return 1; }
    mv "$f.tmp-ipv6" "$f" || { err "改写失败：$f"; return 1; }
    ok "已注释 $f 里的 $n 段 inet6 static 配置"
    dim "  恢复 IPv6 时先拷回去：cp $bak $f && systemctl restart networking"
  done
  return 0
}

# 把本次新注释的 static 段恢复原样（只恢复本次新建备份的文件）
_ipv6_restore_new_commented() {
  local f
  [ -n "${IPV6_NEW_BAK_FILES:-}" ] || return 0
  # shellcheck disable=SC2086
  for f in $IPV6_NEW_BAK_FILES; do
    if [ -f "$f.bak-ipv6" ]; then
      cp -p "$f.bak-ipv6" "$f" 2>/dev/null \
        && dim "  已恢复 $f（从 $f.bak-ipv6）" \
        || warn "  恢复失败：$f，手动执行：cp $f.bak-ipv6 $f"
    fi
  done
  IPV6_NEW_BAK_FILES=""
}

_ipv6_disable_permanent() {
  # 只对 inet6 static 才报警：auto/dhcp 是动态配置，sysctl 禁用与之不冲突；
  # static 段会在开机时让 ifup 尝试加地址（禁了 IPv6 后加不上，会报错），
  # 所以提供一键备份+注释；不注释也可以继续，只是每次开机都会有报错日志。
  local files f static_files="" has_dyn=0
  IPV6_NEW_BAK_FILES=""
  files="$(_ipv6_iface_files)"
  for f in $files; do
    [ -f "$f" ] || continue
    if awk '$1=="iface" && $3=="inet6" && $4=="static" {f=1} END{exit !f}' "$f" 2>/dev/null; then
      static_files="$static_files $f"
    elif awk '$1=="iface" && $3=="inet6" {f=1} END{exit !f}' "$f" 2>/dev/null; then
      has_dyn=1
    fi
  done
  if [ -n "$static_files" ]; then
    warn "检测到 inet6 static 配置：${static_files# }"
    dim "  开机时 ifup 会尝试加这些静态地址（禁了 IPv6 后加不上，会报错）"
    if confirm "先备份并注释掉这些 static 段，再继续禁用？"; then
      # shellcheck disable=SC2086
      _ipv6_comment_static $static_files || { info "已取消"; return 0; }
    else
      confirm "不注释直接继续？" || { info "已取消"; return 0; }
    fi
  elif [ "$has_dyn" = 1 ]; then
    dim "  检测到 inet6 auto/dhcp 动态配置，sysctl 禁用与之不冲突，直接继续"
  fi
  if ! confirm "确认永久禁用 IPv6？"; then
    _ipv6_restore_new_commented
    info "已取消"; return 0
  fi

  mkdir -p /var/lib/vps-toolbox
  local bak=/var/lib/vps-toolbox/ipv6-state.bak
  # 只在第一次写：重复执行「永久禁用」时当前值已经是 1，
  # 再覆盖就把「原始状态」冲掉了（老版本就是这个 bug）。
  if [ -f "$bak" ]; then
    dim "  已有原始状态备份，保留不动：$bak"
  else
    {
      printf 'net.ipv6.conf.all.disable_ipv6=%s\n' "$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null || echo 0)"
      printf 'net.ipv6.conf.default.disable_ipv6=%s\n' "$(sysctl -n net.ipv6.conf.default.disable_ipv6 2>/dev/null || echo 0)"
    } > "$bak"
    dim "  原始状态已备份到 $bak"
  fi

  _ipv6_write_conf
  sysctl --system >/dev/null 2>&1
  local bad
  bad="$(_ipv6_apply 1)" || true

  # 落一份开机后再执行一次的服务，保证重启后不会被网络服务改回去
  _ipv6_write_service
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable disable-ipv6.service >/dev/null 2>&1 || true
  systemctl restart disable-ipv6.service >/dev/null 2>&1 || true

  echo
  if _ipv6_is_disabled; then
    ok "IPv6 已永久禁用（重启后仍生效）"
    dim "  sysctl: /etc/sysctl.d/99-disable-ipv6.conf"
    dim "  开机重放: disable-ipv6.service ($(systemctl is-enabled disable-ipv6.service 2>/dev/null || echo unknown))"
    dim "  备份: $bak"
    dim "  恢复: 回到本菜单选 3"
  else
    err "禁用失败，未禁掉的接口：${bad:-未知}"
    dim "  逐个查：sysctl -a | grep 'net.ipv6.conf.*disable_ipv6'"
    rm -f /etc/sysctl.d/99-disable-ipv6.conf
    _ipv6_remove_service
    # _ipv6_apply 只复位各接口，all/default 也要复位，否则还留在 1
    sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null 2>&1
    sysctl -w net.ipv6.conf.default.disable_ipv6=0 >/dev/null 2>&1
    _ipv6_apply 0 >/dev/null 2>&1 || true
    _ipv6_restore_new_commented
    dim "  已回滚"
    return 1
  fi
}


_ipv6_restore() {
  local has_conf=0 has_svc=0
  [ -f /etc/sysctl.d/99-disable-ipv6.conf ] && has_conf=1
  [ -f /etc/systemd/system/disable-ipv6.service ] && has_svc=1

  if [ "$has_conf" = 0 ] && [ "$has_svc" = 0 ]; then
    warn "没有找到永久禁用配置（sysctl / systemd 都没有）"
    if _ipv6_is_disabled; then
      info "IPv6 当前是禁用的，但没有永久配置 —— 可能是临时禁用（重启即恢复）"
      if confirm "要现在立刻恢复吗？"; then
        sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null 2>&1
        sysctl -w net.ipv6.conf.default.disable_ipv6=0 >/dev/null 2>&1
        _ipv6_apply 0 >/dev/null 2>&1 || true
        ok "已在运行时恢复"
        _ipv6_restore_hint
      fi
    else
      dim "IPv6 本来就是启用的，无需操作"
    fi
    return 0
  fi

  if ! confirm "确认取消永久禁用并恢复 IPv6？"; then
    info "已取消"; return 0
  fi

  rm -f /etc/sysctl.d/99-disable-ipv6.conf
  _ipv6_remove_service

  local bak=/var/lib/vps-toolbox/ipv6-state.bak
  # 「取消禁用」的语义就是启用 IPv6，所以这里固定恢复成 0。
  # 不再拿备份值当恢复依据 —— 老版本重复禁用会把备份写成 1，
  # 那样恢复出来还是禁用状态，越修越乱。备份只留作排查参考。
  local v_all=0 v_def=0
  if [ -f "$bak" ]; then
    local old_all; old_all=$(sed -n 's/^net\.ipv6\.conf\.all\.disable_ipv6=//p' "$bak" | tail -1)
    if [ "$old_all" = "1" ]; then
      dim "  备份记录的是 1（可能是旧版重复禁用写坏的），忽略，直接恢复为启用"
    else
      dim "  备份记录的原始状态: all=${old_all:-0}"
    fi
  fi
  sysctl -w net.ipv6.conf.all.disable_ipv6="$v_all" >/dev/null 2>&1
  sysctl -w net.ipv6.conf.default.disable_ipv6="$v_def" >/dev/null 2>&1
  # 逐个接口恢复（不能只改 all，某些内核不传播）
  _ipv6_apply "$v_all" >/dev/null 2>&1 || true
  # 恢复时同样保证 lo 的 IPv6 是开着的
  sysctl -w net.ipv6.conf.lo.disable_ipv6=0 >/dev/null 2>&1
  sysctl --system >/dev/null 2>&1

  echo
  if _ipv6_is_disabled; then
    warn "IPv6 仍处于禁用状态 —— 还有别的配置在起作用"
    dim "  排查: grep -rn disable_ipv6 /etc/sysctl.conf /etc/sysctl.d/ 2>/dev/null"
    dim "  以及: sysctl -a | grep 'net.ipv6.conf.*disable_ipv6'"
    dim "  备份已保留：$bak"
    return 1
  fi
  # 恢复确认成功后再删备份（以前先删再查，失败就丢了备份）
  rm -f "$bak"
  ok "IPv6 已恢复启用"
  # 之前注释过 static 段的话，只恢复 sysctl 地址回不来，得先把备份拷回去
  local f
  for f in /etc/network/interfaces /etc/network/interfaces.d/*; do
    [ -f "$f.bak-ipv6" ] || continue
    dim "  注意：$f.bak-ipv6 还在，说明之前注释过 static 段"
    dim "  地址没回来时先恢复它：cp $f.bak-ipv6 $f"
  done
  _ipv6_restore_hint
}

act_ipv6() {
  local a
  step "IPv6 管理 —— 临时/永久禁用或恢复"
  info "适用场景：商家 IPv6 路由不通、只想走 IPv4、或排查双栈带来的连接问题"
  echo

  # 状态不能用 all 判断：某些内核里 all=1 但 eth0 仍是 0
  if _ipv6_is_disabled; then
    printf '  当前状态: %s已禁用%s\n' "$RED" "$NC"
  else
    local badif="" anyoff=0 i
    for i in $(_ipv6_ifs); do
      if [ "$(sysctl -n "net.ipv6.conf.${i}.disable_ipv6" 2>/dev/null)" = "1" ]; then
        anyoff=1
      else
        badif="$badif $i"
      fi
    done
    # 只有「至少一个接口已禁用、至少一个仍启用」才算部分禁用；
    # 一个都没禁用时（all=1 但内核没传播的场景）就是完全启用，不能误标
    if [ -n "$badif" ] && [ "$anyoff" = 1 ]; then
      printf '  当前状态: %s部分禁用%s（%s 仍是启用，IPv6 实际在工作）\n' "$YELLOW" "$NC" "${badif# }"
    else
      printf '  当前状态: %s已启用%s\n' "$GREEN" "$NC"
    fi
  fi

  local addrs
  addrs="$(_ipv6_addrs)"
  if [ -n "$addrs" ]; then
    printf '%s\n' "$addrs" | sed "s/^/  ${DIM}地址: /; s/\$/${NC}/"
  else
    dim "  地址: 无"
  fi

  if [ -f /etc/sysctl.d/99-disable-ipv6.conf ]; then
    warn "存在永久禁用配置 /etc/sysctl.d/99-disable-ipv6.conf"
  fi

  echo
  info "  1) 临时禁用      ${DIM}sysctl -w，只改运行时，重启自动恢复${NC}"
  info "  2) 永久禁用      ${DIM}写 /etc/sysctl.d/99-disable-ipv6.conf${NC}"
  info "  3) 取消永久禁用  ${DIM}删除配置并尽力恢复 IPv6${NC}"
  info "  0) 返回"
  echo
  ask "  请选择 [0-3]: " a

  case "${a:-0}" in
    1) _ipv6_disable_runtime ;;
    2) _ipv6_disable_permanent ;;
    3) _ipv6_restore ;;
    *) return 0 ;;
  esac
}

act_lite() {
  step "Komari / Lite Agent 安装"
  info "nuomiiiii/lite 的 POSIX 安装脚本（systemd 与 OpenWrt 通用）"
  run_remote "install-lite.sh" \
    "https://raw.githubusercontent.com/nuomiiiii/lite/main/install-lite.sh?$(date +%s)" \
    sh
}

act_nodequality() {
  step "NodeQuality —— 综合测评（IP 质量 / 硬件 / 网络 / 回程）"
  info "会下载 BenchOS 运行环境，耗时较长（数分钟）"
  run_remote "NodeQuality" "https://run.NodeQuality.com?$(date +%s)" bash
}

act_tcpquality() {
  step "TcpQuality —— TCP 质量测试"
  info "默认在临时 Debian rootfs 的 chroot 中运行"
  run_remote "TcpQuality" \
    "https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh?$(date +%s)" \
    bash
}

act_iperf3() {
  step "iperf3 服务端 —— 状态 / 启动 / 停止"
  info "需要测速时才启动，用完可以关掉（不占端口、不随开机启动）"
  echo

  # ---------- 确保已安装 ----------
  if ! command -v iperf3 >/dev/null 2>&1; then
    info "iperf3 未安装，正在安装 ..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iperf3 >/dev/null 2>&1
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q iperf3 >/dev/null 2>&1
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q iperf3 >/dev/null 2>&1
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache iperf3 >/dev/null 2>&1
    fi
    if ! command -v iperf3 >/dev/null 2>&1; then
      err "自动安装失败，请手动装：apt install -y iperf3"
      return 1
    fi
    ok "已安装：$(iperf3 --version 2>&1 | head -1)"
  fi

  # ss 属于 iproute2，精简系统可能没装 —— 没有就装，否则下面读不到端口
  if ! command -v ss >/dev/null 2>&1; then
    if   command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iproute2 >/dev/null 2>&1 || true
    elif command -v dnf     >/dev/null 2>&1; then dnf install -y -q iproute2 >/dev/null 2>&1 || true
    elif command -v yum     >/dev/null 2>&1; then yum install -y -q iproute2 >/dev/null 2>&1 || true
    elif command -v apk     >/dev/null 2>&1; then apk add --no-cache iproute2 >/dev/null 2>&1 || true
    fi
  fi

  local a running curport port myip unit_state unit_active unit_exists stopped
  while true; do
    # ---------- 刷新状态 ----------
    running=0; curport=""
    if pgrep -x iperf3 >/dev/null 2>&1; then
      running=1
      curport=$(ss -tlnp 2>/dev/null | grep iperf3 | head -1 | sed -E 's/.*:([0-9]+)[[:space:]].*/\1/')
    fi
    unit_state=""; unit_active=""; unit_exists=0
    if systemctl list-unit-files 2>/dev/null | grep -q '^iperf3\.service'; then
      unit_exists=1
      unit_state=$(systemctl is-enabled iperf3.service 2>/dev/null || echo unknown)
      unit_active=$(systemctl is-active iperf3.service 2>/dev/null || echo unknown)
    fi

    echo
    hr
    if [ "$running" = 1 ]; then
      ok "当前状态：iperf3 【运行中】"
      printf '    PID  : %s\n' "$(pgrep -x iperf3 | tr '\n' ' ')"
      printf '    端口 : %s\n' "${curport:-未知}"
      ss -tlnp 2>/dev/null | grep iperf3 | sed 's/^/    /'
    else
      warn "当前状态：iperf3 【未运行 / 已关闭】"
      dim "    不占端口，也不随开机启动 —— 只有你手动启动时才会跑"
    fi
    if [ "$unit_exists" = 1 ] && [ "$unit_active" = "active" ]; then
      warn "iperf3.service 正由 systemd 托管（Restart=always）—— 直接 kill 会在 15 秒后自动拉起"
      dim "    选 2 停止会连 systemd 一起 disable，那才是真的关掉"
    elif [ "$unit_state" = "enabled" ]; then
      warn "iperf3.service 处于 enabled（开机会自动启动，装包时被自动打开的）"
      dim "    选 2 停止会一并 systemctl disable"
    fi
    hr
    echo
    info "  1) 启动（可指定端口，默认 5201）"
    info "  2) 停止（关闭，释放端口）"
    info "  3) 重启（换端口）"
    info "  4) 显示测速命令"
    info "  0) 返回"
    echo
    if ! ask "  请选择 [0-4]: " a; then return 0; fi

    case "${a:-0}" in
      1)
        if [ "$running" = 1 ]; then
          warn "已经在运行（端口 ${curport:-?}）。要换端口请选 3。"
        else
          if ! ask "  监听端口 [默认 5201]: " port; then return 0; fi
          port="${port:-5201}"
          if ! [ "$port" -ge 1 ] 2>/dev/null || [ "$port" -gt 65535 ] 2>/dev/null; then
            err "端口不合法：$port"; continue
          fi
          if [ "$unit_exists" = 1 ] && { [ "$unit_active" = "active" ] || [ "$unit_state" = "enabled" ]; }; then
            info "先关掉 systemd 托管的 iperf3.service（stop + 取消开机自启）"
            systemctl disable --now iperf3 >/dev/null 2>&1 || true
            sleep 1
          fi
          iperf3 -s -D -p "$port" >/dev/null 2>&1 || true
          sleep 1
          if pgrep -x iperf3 >/dev/null 2>&1; then
            ok "已启动（端口 $port）"
            dim "  防火墙放行: iptables -I INPUT -p tcp --dport $port -j ACCEPT"
            dim "  ⚠️ 云安全组也要放行 TCP $port"
          else
            err "启动失败 —— 端口 $port 可能被占用"
            ss -tlnp 2>/dev/null | grep ":$port " | sed 's/^/    /' || true
          fi
        fi
        ;;
      2)
        stopped=0
        if [ "$unit_exists" = 1 ] && { [ "$unit_active" = "active" ] || [ "$unit_state" = "enabled" ]; }; then
          info "关闭 systemd 托管的 iperf3.service（stop + 取消开机自启）"
          systemctl disable --now iperf3 >/dev/null 2>&1 || true
          stopped=1
        fi
        if pgrep -x iperf3 >/dev/null 2>&1; then
          pkill -x iperf3 2>/dev/null || true
          stopped=1
        fi
        [ "$stopped" = 1 ] && sleep 2
        if pgrep -x iperf3 >/dev/null 2>&1; then
          err "停止失败，进程还在：$(pgrep -x iperf3 | tr '\n' ' ')"
        elif [ "$stopped" = 1 ]; then
          ok "已停止，端口已释放"
          [ "$unit_exists" = 1 ] && dim "  systemd 已 disable —— 重启机器也不会自己起来"
        else
          dim "  本来就没在跑"
        fi
        ;;
      3)
        if [ "$running" = 0 ]; then
          warn "当前没在运行，请选 1 启动"
        else
          if ! ask "  新端口 [当前 ${curport:-5201}]: " port; then return 0; fi
          port="${port:-${curport:-5201}}"
          if ! [ "$port" -ge 1 ] 2>/dev/null || [ "$port" -gt 65535 ] 2>/dev/null; then
            err "端口不合法：$port"; continue
          fi
          if [ "$unit_exists" = 1 ] && { [ "$unit_active" = "active" ] || [ "$unit_state" = "enabled" ]; }; then
            systemctl disable --now iperf3 >/dev/null 2>&1 || true
          fi
          pkill -x iperf3 2>/dev/null || true
          sleep 1
          iperf3 -s -D -p "$port" >/dev/null 2>&1 || true
          sleep 1
          if pgrep -x iperf3 >/dev/null 2>&1; then
            ok "已重启到端口 $port"
          else
            err "重启失败 —— 端口 $port 可能被占用"
          fi
        fi
        ;;
      4)
        if [ "$running" = 1 ]; then
          myip=""
          if [ "$HAVE_CURL" = 1 ]; then
            myip=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null)
          elif [ "$HAVE_WGET" = 1 ]; then
            myip=$(wget -q -T 5 -t 1 -O - https://ifconfig.me 2>/dev/null)
          fi
          myip="${myip:-<本机IP>}"
          echo
          info "在【另一台机器】上跑："
          dim "  iperf3 -c $myip -p ${curport:-5201} -t 30 -P 8 -R      # 下载方向（服务器→你）"
          dim "  iperf3 -c $myip -p ${curport:-5201} -t 30 -P 8         # 上传方向（你→服务器）"
          echo
          dim "  -P 8 是多流（单流受 TCP 拥塞影响，测不准）；-R 是反向"
        else
          warn "iperf3 没在运行，先选 1 启动"
        fi
        ;;
      *) return 0 ;;
    esac
  done
}

# 确保 aria2 已安装，未装则安装；成功返回 0
_aria2_ensure_installed() {
  if command -v aria2c >/dev/null 2>&1; then
    ok "aria2 已安装：$(aria2c --version 2>&1 | head -1)"
    return 0
  fi
  info "aria2 未安装，正在安装 ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq aria2 >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q aria2 >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q aria2 >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache aria2 >/dev/null 2>&1
  else
    err "找不到支持的包管理器，请手动安装 aria2"
    return 1
  fi
  if ! command -v aria2c >/dev/null 2>&1; then
    err "自动安装失败，请手动装：apt install -y aria2"
    return 1
  fi
  ok "已安装：$(aria2c --version 2>&1 | head -1)"
}

# 彻底卸载 aria2：停进程 → 删下载目录/日志 → 卸包 → 残留自检
_aria2_uninstall() {
  step "卸载 aria2（彻底清理）"
  hr
  info "将执行以下清理："
  info "  1) 停止 aria2c 下载进程"
  info "  2) 停止本工具开启的网页下载服务"
  info "  3) 删除下载目录 /opt/downloads（含全部文件）"
  info "  4) 删除日志 /tmp/aria2*.log、/tmp/http-<端口>.log"
  info "  5) 卸载 aria2 软件包"
  echo
  if command -v aria2c >/dev/null 2>&1; then
    info "aria2 版本：$(aria2c --version 2>&1 | head -1)"
  else
    dim "  aria2c 命令不存在（可能已经卸载）"
  fi
  if [ -d /opt/downloads ]; then
    local cnt sz
    cnt=$(find /opt/downloads -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
    sz=$(du -sh /opt/downloads 2>/dev/null | awk '{print $1}')
    info "下载目录：/opt/downloads（${cnt} 项，${sz:-?}）"
  fi
  local srvport
  srvport=$(pgrep -a -f "python3 -m http\.server.*--directory /opt/downloads" 2>/dev/null | grep -o 'http.server [0-9]*' | awk '{print $2}' | head -1)
  [ -n "$srvport" ] && info "网页下载服务：运行中（端口 $srvport）"
  echo
  warn "下载文件与日志删除后不可恢复；aria2 包会被卸载（不区分原先是谁装的）"
  if ! confirm_explicit "确认彻底卸载 aria2？"; then info "已取消"; return 0; fi

  # 1) 停进程
  local stopped=0
  if pgrep -x aria2c >/dev/null 2>&1; then
    pkill -x aria2c 2>/dev/null || true
    stopped=1
  fi
  if pgrep -f "python3 -m http\.server.*--directory /opt/downloads" >/dev/null 2>&1; then
    # 逐个核对命令行，只杀本工具启动的实例，不碰别的 http.server
    local p cmd
    for p in $(pgrep -f "python3 -m http\.server.*--directory /opt/downloads" 2>/dev/null); do
      cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
      case "$cmd" in
        *"--directory /opt/downloads"*) kill "$p" 2>/dev/null || true ;;
      esac
    done
    stopped=1
  fi
  [ "$stopped" = 1 ] && { sleep 1; ok "相关进程已停止"; }

  # 2) 删目录和日志（find -delete 连隐藏文件一起清）
  rm -rf /opt/downloads
  rm -f /tmp/aria2*.log /tmp/http-[0-9]*.log
  ok "下载目录与日志已删除"

  # 3) 卸包
  local rc=0
  if   command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq aria2 >/dev/null 2>&1 || rc=$?
    # purge 后 dpkg 若残留 rc 状态，再清一次
    if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${db:Status-Abbrev}' aria2 2>/dev/null | grep -q '^rc'; then
      dpkg --purge aria2 >/dev/null 2>&1 || true
    fi
  elif command -v dnf >/dev/null 2>&1; then
    dnf remove -y -q aria2 >/dev/null 2>&1 || rc=$?
  elif command -v yum >/dev/null 2>&1; then
    yum remove -y -q aria2 >/dev/null 2>&1 || rc=$?
  elif command -v apk >/dev/null 2>&1; then
    apk del aria2 >/dev/null 2>&1 || rc=$?
  else
    err "找不到支持的包管理器，请手动卸载 aria2 包"
    rc=1
  fi
  # 以「命令是否还在」为准判断结果，比包管理器退出码更可靠（如包本就不存在时 purge 会返回非 0）
  if ! command -v aria2c >/dev/null 2>&1; then
    ok "aria2 软件包已卸载"
  else
    warn "aria2c 仍存在，卸载可能未成功（包管理器退出码 $rc），请手动检查"
  fi

  # 4) 残留自检
  hr
  info "残留自检："
  local left=0 x
  command -v aria2c >/dev/null 2>&1 && { err "aria2c 命令仍存在"; left=1; }
  pgrep -x aria2c >/dev/null 2>&1 && { err "aria2c 进程仍在运行"; left=1; }
  pgrep -f "python3 -m http\.server.*--directory /opt/downloads" >/dev/null 2>&1 && { err "网页下载服务仍在运行"; left=1; }
  [ -e /opt/downloads ] && { err "/opt/downloads 仍存在"; left=1; }
  x=$(find /tmp -maxdepth 1 \( -name 'aria2*.log' -o -name 'http-[0-9]*.log' \) -print 2>/dev/null)
  if [ -n "$x" ]; then
    err "以下日志仍存在："
    printf '%s\n' "$x" | sed 's/^/    /'
    left=1
  fi
  if command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f='${db:Status-Abbrev}\n' aria2 2>/dev/null | grep -q '^rc' && warn "dpkg 中 aria2 仍有 rc 状态记录（非文件残留）"
  fi
  if [ "$left" = 0 ]; then
    ok "未发现残留，卸载干净"
  else
    warn "仍有上述残留，请按提示手动处理"
  fi
  hr
}

act_aria2() {
  step "aria2 下载工具"
  local choice url id log free_mb lastprog lastfile port myip srvport
  while true; do
    echo
    info "  1) 安装 aria2"
    info "  2) 下载（输入磁力链接或直链）"
    info "  3) 查看下载进度"
    info "  4) 清除下载文件"
    info "  5) 网页下载服务（开端口，浏览器里下）"
    info "  6) 卸载 aria2（含下载文件，彻底清理）"
    info "  0) 返回"
    if ! ask "  请选择 [0-6]: " choice; then return 0; fi
    case "$choice" in
      1)
        _aria2_ensure_installed || continue
        mkdir -p /opt/downloads
        ok "下载目录：/opt/downloads"
        echo
        df -h /opt
        ;;
      2)
        _aria2_ensure_installed || continue
        mkdir -p /opt/downloads
        if ! ask "  输入下载地址（磁力链接或 http(s) 直链）: " url; then continue; fi
        url="$(printf '%s' "$url" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        # 粘贴时可能带上首尾引号，先剥掉
        url="${url#\"}"; url="${url%\"}"
        url="${url#"'"}"; url="${url%"'"}"
        if [ -z "$url" ]; then warn "地址为空，已取消"; continue; fi
        case "$url" in
          magnet:\?*|http://*|https://*) ;;
          *) err "地址格式不对：只支持 magnet:? 开头的磁力链接或 http(s) 直链"; continue ;;
        esac
        # 按完整参数匹配：子串匹配会把「同一文件不同参数的直链」误判为重复
        if pgrep -a aria2c 2>/dev/null | awk -v u="$url" '{for(i=1;i<=NF;i++) if($i==u) f=1} END{exit f?0:1}'; then
          warn "这个地址正在下载中，重复添加已跳过"
          continue
        fi
        # 用 -BM 取兆数比较：-BG 向上取整，1.5G 会显示成 2G，跳过「不足 2G」警告
        free_mb=$(df --output=avail -BM /opt 2>/dev/null | tail -1 | tr -dc '0-9')
        if [ -n "$free_mb" ] && [ "$free_mb" -lt 2048 ] 2>/dev/null; then
          warn "/opt 可用空间不足 2G（剩余约 ${free_mb}M），大文件可能下到一半失败"
          confirm "仍要继续吗？" || continue
        fi
        id="$(date +%Y%m%d-%H%M%S)-$RANDOM"
        log="/tmp/aria2-$id.log"
        # 直接后台启动，不包子 shell：( ... & ) 会留一个 bash 父进程攥着终端不退出
        setsid aria2c --dir=/opt/downloads --seed-time=0 --bt-tracker="$ARIA2_TRACKERS" "$url" >"$log" 2>&1 < /dev/null &
        sleep 2
        # 小文件直链可能在 2 秒内下完退出，单看进程会误报「启动失败」。
        # 进程还在 = 下载中；进程已退但日志有 Download complete = 秒下完（也是成功）。
        if pgrep -a aria2c 2>/dev/null | awk -v u="$url" '{for(i=1;i<=NF;i++) if($i==u) f=1} END{exit f?0:1}' \
           || grep -qiE 'Download (complete|complete:)|下载完成' "$log" 2>/dev/null; then
          ok "已开始下载，日志：$log"
          dim "  选 3 可以查看进度；退出菜单、断开 SSH 都不会停"
        else
          err "启动失败，看日志找原因：$log"
          tail -5 "$log" 2>/dev/null | sed 's/^/  /'
        fi
        ;;
      3)
        echo
        if pgrep -x aria2c >/dev/null 2>&1; then
          info "运行中的下载："
          pgrep -a aria2c 2>/dev/null | grep -o 'magnet:?[^ ]*\|https\?://[^ ]*' | sed 's/^/  /'
        else
          dim "  当前没有正在进行的下载"
        fi
        echo
        info "各任务最新进度："
        for log in /tmp/aria2-*.log /tmp/aria2.log; do
          [ -f "$log" ] || continue
          lastprog=$(grep '^\[#' "$log" 2>/dev/null | tail -1)
          lastfile=$(grep '^FILE:' "$log" 2>/dev/null | tail -1)
          [ -n "$lastprog" ] || [ -n "$lastfile" ] || continue
          printf '  %s\n' "$(basename "$log")"
          [ -n "$lastprog" ] && printf '    %s\n' "$lastprog"
          [ -n "$lastfile" ] && printf '    %s\n' "$lastfile"
        done
        echo
        info "已下载文件（/opt/downloads）："
        if [ -d /opt/downloads ] && [ -n "$(ls -A /opt/downloads 2>/dev/null)" ]; then
          ls -lh /opt/downloads | sed 's/^/  /'
          du -sh /opt/downloads 2>/dev/null | sed 's/^/  合计：/'
        else
          dim "  下载目录为空"
        fi
        ;;
      4)
        if [ ! -d /opt/downloads ] || [ -z "$(ls -A /opt/downloads 2>/dev/null)" ]; then
          dim "下载目录已经是空的，没什么可清"
          continue
        fi
        echo
        ls -lh /opt/downloads | sed 's/^/  /'
        du -sh /opt/downloads 2>/dev/null | sed 's/^/  合计：/'
        if pgrep -x aria2c >/dev/null 2>&1; then
          warn "有下载正在进行，清除会先停止它们"
        fi
        if ! confirm "确定删除 /opt/downloads 下的全部文件吗？"; then warn "已取消"; continue; fi
        pkill -x aria2c 2>/dev/null || true
        sleep 1
        # find -delete 连隐藏文件一起清（glob 的 * 匹配不到点文件）
        find /opt/downloads -mindepth 1 -delete 2>/dev/null
        rm -f /tmp/aria2*.log
        if [ -z "$(ls -A /opt/downloads 2>/dev/null)" ]; then
          ok "已清除"
        else
          err "清除不完全，/opt/downloads 里还有文件残留"
        fi
        ;;
      5)
        if ! command -v python3 >/dev/null 2>&1; then
          err "没找到 python3，装一下再用：apt install -y python3"
          continue
        fi
        # ss 属于 iproute2，精简系统可能没装 —— 没有就装，否则下面端口检查和启动验证都读不到
        if ! command -v ss >/dev/null 2>&1; then
          if   command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iproute2 >/dev/null 2>&1 || true
          elif command -v dnf     >/dev/null 2>&1; then dnf install -y -q iproute2 >/dev/null 2>&1 || true
          elif command -v yum     >/dev/null 2>&1; then yum install -y -q iproute2 >/dev/null 2>&1 || true
          elif command -v apk     >/dev/null 2>&1; then apk add --no-cache iproute2 >/dev/null 2>&1 || true
          fi
        fi
        mkdir -p /opt/downloads
        srvport=$(pgrep -a -f "python3 -m http\.server.*--directory /opt/downloads" 2>/dev/null | grep -o 'http.server [0-9]*' | awk '{print $2}' | head -1)
        if [ -n "$srvport" ]; then
          myip=""
          if [ "$HAVE_CURL" = 1 ]; then
            myip=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null)
          fi
          [ -n "$myip" ] || myip=$(hostname -I 2>/dev/null | awk '{print $1}')
          ok "网页下载服务运行中：http://${myip:-服务器IP}:$srvport"
          warn "  注意：此服务无密码、明文传输，任何能访问该端口的人都能列出并下载 /opt/downloads 全部文件"
          warn "  建议仅在受信任网络使用，或配合防火墙限制来源 IP；用完立即关闭"
          if confirm "是否关闭它？"; then
            # 只关本工具启动的那个（端口 + /opt/downloads 目录都对上才杀），不碰别的 http.server
            pkill -f "python3 -m http\.server $srvport --directory /opt/downloads" 2>/dev/null || true
            sleep 1
            if pgrep -f "python3 -m http\.server $srvport --directory /opt/downloads" >/dev/null 2>&1; then
              warn "关闭失败，请手动处理"
            else
              ok "已关闭"
            fi
          fi
          continue
        fi
        if ! ask "  端口 [默认 8000]: " port; then continue; fi
        port="${port:-8000}"
        if ! [ "$port" -ge 1 ] 2>/dev/null || [ "$port" -gt 65535 ] 2>/dev/null; then
          err "端口不合法：$port"; continue
        fi
        if ss -tln 2>/dev/null | grep -q ":$port "; then
          err "端口 $port 已被占用，换一个"; continue
        fi
        # 直接后台启动，不包子 shell：( ... & ) 会留一个 bash 父进程攥着终端不退出
        setsid python3 -m http.server "$port" --directory /opt/downloads >/tmp/http-"$port".log 2>&1 < /dev/null &
        sleep 1
        if ss -tln 2>/dev/null | grep -q ":$port "; then
          myip=""
          if [ "$HAVE_CURL" = 1 ]; then
            myip=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null)
          fi
          [ -n "$myip" ] || myip=$(hostname -I 2>/dev/null | awk '{print $1}')
          ok "已开启：http://${myip:-服务器IP}:$port"
          warn "  注意：此服务无密码、明文传输，任何能访问该端口的人都能列出并下载 /opt/downloads 全部文件"
          warn "  建议仅在受信任网络使用，或配合防火墙限制来源 IP；用完回来选 5 关闭"
        else
          err "启动失败，看日志：/tmp/http-$port.log"
        fi
        ;;
      6) _aria2_uninstall ;;
      0) return 0 ;;
      *) err "无效选项：$choice" ;;
    esac
  done
}

act_docker() {
  step "Docker 安装 —— 容器化应用的前置依赖"
  if command -v docker >/dev/null 2>&1; then
    ok "Docker 已安装：$(docker --version 2>/dev/null)"
    docker compose version 2>/dev/null | sed 's/^/    /' || true
    docker info --format '    数据目录: {{.DockerRootDir}}   存储驱动: {{.Driver}}' 2>/dev/null || true
    printf '    服务状态: '; systemctl is-active docker 2>/dev/null || echo unknown
    local cnt
    cnt=$(docker ps -q 2>/dev/null | wc -l)
    printf '    运行中容器: %s 个\n' "${cnt:-0}"
    echo
    dim "  已安装，跳过安装（重装会重启 docker 守护进程，把所有容器停掉）"
    dim "  真要重装：先下载到本地检查再执行，不要直接管道给 sh"
    dim "    curl -fsSL -o /tmp/get-docker.sh $DOCKER_GET_URL && sh /tmp/get-docker.sh"
    echo
    info "常用命令："
    dim "  docker ps                看运行中的容器"
    dim "  docker compose up -d     按当前目录的 compose 启动"
    dim "  docker system df         看空间占用"
    dim "  docker image prune -f    清悬空镜像"
    return 0
  fi

  info "将使用 Docker 官方脚本：$DOCKER_GET_URL"
  dim "  自动配置 apt/yum 源，安装 docker-ce + compose 插件 + buildx"
  dim "  国内机器如果卡住，先在「1) 安装基础依赖」里确认网络，或自行配镜像源"
  echo
  if ! confirm "确认安装？"; then warn "已取消"; return 0; fi

  # 走 run_remote：落盘 + 非空 + HTML 检查，不再裸下载执行。
  # 上游 get-docker.sh 标志行已对照源码核对（Docker Engine for Linux installation script.，2026-11-19），REMOTE_MARKERS 里已加。
  step "执行安装（约 1-3 分钟）"
  local rc=0
  run_remote "get-docker.sh" "$DOCKER_GET_URL" sh || rc=$?

  echo
  if command -v docker >/dev/null 2>&1; then
    ok "$(docker --version 2>/dev/null)"
    printf '  服务状态: '; systemctl is-active docker 2>/dev/null || echo unknown
    docker compose version 2>/dev/null | sed 's/^/  /' || dim "  (compose 插件可能需单独装)"
    if [ -z "$(docker ps -q 2>/dev/null)" ] && ! docker info >/dev/null 2>&1; then
      warn "docker 命令在但守护进程没起来，试：systemctl enable --now docker"
    fi
  else
    err "安装失败（退出码 $rc）"
    dim "  排查：确认能访问 download.docker.com，或手动下载检查后执行"
    dim "    curl -fsSL -o /tmp/get-docker.sh $DOCKER_GET_URL && sh /tmp/get-docker.sh"
    return 1
  fi
}

act_flyx() {
  step "Flyx 面板 —— 一键安装脚本（kure29/flyx）"
  info "发布页：https://github.com/kure29/flyx/releases/latest"
  echo
  dim "  安装命令："
  dim "  curl -L https://github.com/kure29/flyx/releases/latest/download/panel_install.sh -o panel_install.sh && chmod +x panel_install.sh && ./panel_install.sh"
  echo
  dim "  要求: Debian/Ubuntu + root；需要能访问 github.com"
  dim "  访问不了 github 时可在 https://github.com/ 前加加速前缀（如 https://ghfast.top/）"
  echo
  if ! confirm "确认执行？"; then warn "已取消"; return 0; fi

  local dir rc=0
  # 临时目录名带上本进程 PID：多实例并发时 trap 只清自己的
  dir="$(mktemp -d "${TMPDIR:-/tmp}/vpstool.$$.XXXXXX")" || { err "无法创建临时目录"; return 1; }

  step "下载 panel_install.sh"
  if ! fetch "https://github.com/kure29/flyx/releases/latest/download/panel_install.sh" "$dir/panel_install.sh"; then
    err "下载失败（网络不通 / 地址失效 / 被墙）"
    rm -rf "$dir"; return 1
  fi
  if [ ! -s "$dir/panel_install.sh" ]; then
    err "下载内容为空"
    rm -rf "$dir"; return 1
  fi
  # 内容校验：先拒掉 HTML 错误页，再核对标志行（上游标志行已对照源码核对，REPO="kure29/flyx"，2026-11-19）。
  # 这里不走 run_remote：安装脚本要在自己的目录里跑（cd "$dir"），换执行目录可能改行为。
  if head -c 512 "$dir/panel_install.sh" | grep -qiE '<!DOCTYPE|<html|404: Not Found|AccessDenied'; then
    err "下载内容是 HTML 错误页，不是脚本，拒绝执行"
    rm -rf "$dir"; return 1
  fi
  if ! grep -qF -- 'REPO="kure29/flyx"' "$dir/panel_install.sh"; then
    err "下载内容缺少标志行 REPO=\"kure29/flyx\"，不是 Flyx 安装脚本，拒绝执行"
    rm -rf "$dir"; return 1
  fi
  chmod +x "$dir/panel_install.sh"
  ok "已下载 $(wc -c < "$dir/panel_install.sh") 字节"

  step "执行 Flyx 面板安装"
  dim "交互式操作请按提示直接输入；Ctrl+C 可中断"
  hr
  if [ "$HAVE_TTY" = 1 ]; then
    ( cd "$dir" && ./panel_install.sh ) < /dev/tty || rc=$?
  else
    ( cd "$dir" && ./panel_install.sh ) || rc=$?
  fi
  rm -rf "$dir"
  hr
  if [ "$rc" = 0 ]; then
    ok "Flyx 面板安装脚本执行完成"
    dim "  面板地址 / 端口以安装脚本输出为准"
  else
    warn "安装脚本退出码：$rc"
  fi
}

act_miaomiaowux() {
  step "妙妙屋X 主控安装 —— 一键安装脚本"
  info "仓库：https://github.com/iluobei/miaomiaowuX"
  echo
  dim "  安装主控（Master），默认端口 12889；装完按脚本输出访问面板"
  dim "  要求: Debian/Ubuntu、RHEL 系或 Alpine + root；需要能访问 github.com"
  echo
  if ! confirm "确认执行？"; then warn "已取消"; return 0; fi

  # 上游 install.sh 标志行已对照源码核对（# 妙妙屋X - Xray 服务器管理与订阅拼车系统 安装脚本，2026-11-22），REMOTE_MARKERS 里已加 mmwx-install。
  run_remote "mmwx-install" \
    "https://raw.githubusercontent.com/iluobei/miaomiaowuX/main/install.sh" \
    bash
}

act_status() {
  step "系统状态汇总"
  local cc qd
  info "系统    : $( (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-未知}") )"
  info "内核    : $(uname -r)   ($(uname -m))"
  info "虚拟化  : $(systemd-detect-virt 2>/dev/null || echo 未知)"
  info "CPU     : $(nproc) 核   负载: $(cut -d' ' -f1-3 /proc/loadavg)"
  info "内存    : $(free -m | awk '/^Mem:/{printf "%dMB 总 / %dMB 可用", $2, $7}')"
  info "Swap    : $(free -m | awk '/^Swap:/{printf "%dMB 总 / %dMB 已用", $2, $3}')"
  info "磁盘 /  : $(df -hP / | awk 'NR==2{printf "%s 总 / %s 已用 (%s)", $2, $3, $5}')"
  info "时区    : $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo 未知)"
  info "当前时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  info "运行时长: $(uptime -p 2>/dev/null || uptime)"
  hr
  info "网络地址:"
  local v4 v6 p4 p6 gw4 gw6 vfilter
  # 过滤掉 docker / 网桥 / 容器 等虚拟网卡，只留真实对外网卡
  vfilter='^(docker|br-|veth|virbr|cni|flannel|cali|kube|podman|lxc)'
  v4=$(ip -4 -o addr show scope global 2>/dev/null | awk -v re="$vfilter" '$2 !~ re {print $4}' | tr '\n' ' ' | sed 's/ $//')
  v6=$(ip -6 -o addr show scope global 2>/dev/null | awk -v re="$vfilter" '$2 !~ re {print $4}' | tr '\n' ' ' | sed 's/ $//')
  gw4=$(ip -4 route show default 2>/dev/null | awk '{print $3}' | head -1)
  gw6=$(ip -6 route show default 2>/dev/null | awk '{print $3}' | head -1)
  printf '  %s本地 IPv4%s : %s\n' "$DIM" "$NC" "${v4:-无}"
  printf '  %s本地 IPv6%s : %s\n' "$DIM" "$NC" "${v6:-无}"
  printf '  %s默认网关%s : IPv4 %s   IPv6 %s\n' "$DIM" "$NC" "${gw4:-无}" "${gw6:-无}"
  # 出口 IP：best effort，各 5 秒超时，拿不到就写"取不到"
  if command -v curl >/dev/null 2>&1; then
    p4=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null)
    p6=$(curl -6 -s --max-time 5 https://ifconfig.me 2>/dev/null)
  elif command -v wget >/dev/null 2>&1; then
    p4=$(wget -q -4 -T 5 -t 1 -O - https://ifconfig.me 2>/dev/null)
    p6=$(wget -q -6 -T 5 -t 1 -O - https://ifconfig.me 2>/dev/null)
  fi
  if [ "$HAVE_CURL" = 1 ] || [ "$HAVE_WGET" = 1 ]; then
    printf '  %s出口 IPv4%s : %s\n' "$DIM" "$NC" "${p4:-取不到（可能没有 IPv4 出口）}"
    printf '  %s出口 IPv6%s : %s\n' "$DIM" "$NC" "${p6:-取不到（可能没有 IPv6 出口）}"
  else
    dim "  出口 IP: 需要 curl 或 wget（可选 1 装依赖）"
  fi
  hr
  cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo '?')
  qd=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo '?')
  info "拥塞控制: $cc     队列算法: $qd"
  if [ "$cc" = "bbr" ]; then ok "BBR 已启用"; else warn "BBR 未启用"; fi
  if command -v modinfo >/dev/null 2>&1; then
    local bv; bv=$(modinfo tcp_bbr 2>/dev/null | awk '/^version:/{print $2}')
    [ -n "${bv:-}" ] && info "tcp_bbr 模块版本: $bv  （v3 通常为 3.x）"
  fi
  hr
  info "journald: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMG]' | head -1)"
  hr
  info "监听端口:"
  ss -tlnp 2>/dev/null | awk 'NR>1{split($4,a,":"); printf "    %-8s %s\n", a[length(a)], $6}' | head -14
  hr
  info "相关服务状态:"
  local found=0 s st
  for s in vless-reality xray sing-box hysteria-server lite-agent komari-agent docker caddy nginx snell-server wg-quick@wg0; do
    st=$(systemctl is-active "$s" 2>/dev/null || true)
    if [ -n "$st" ] && [ "$st" != "inactive" ] && [ "$st" != "unknown" ]; then
      printf '    %-20s %s\n' "$s" "$st"; found=1
    fi
  done
  [ "$found" = 0 ] && dim "    （未检测到常见服务）"
  if command -v docker >/dev/null 2>&1; then
    hr; info "Docker 容器:"
    docker ps -a --format '    {{.Names}}: {{.Status}} ({{.Image}})' 2>/dev/null | head -10
  fi
}

act_reinstall() {
  local c os="" ver="" pw="" key="" img="" winname="" wlang=""
  local sport="" ans="" rc=0 tmp="" url="https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh"

  step "重装系统 —— bin456789/reinstall  (13.5k star)"
  printf '  %s%s⚠  此操作会清空整台机器的所有数据  ⚠%s\n' "$RED" "$BOLD" "$NC"
  warn "重装期间机器完全离线，请先确认服务商控制台 / VNC / 救援模式可用"
  warn "确认无误后再继续，重装失败可能只能让服务商救援"
  echo
  info "请选择要安装的系统："
  printf '     %s1)%s Debian 12          %s最常用、最稳%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '     %s2)%s Debian 13\n' "$GREEN" "$NC"
  printf '     %s3)%s Ubuntu 24.04\n' "$GREEN" "$NC"
  printf '     %s4)%s Ubuntu 22.04\n' "$GREEN" "$NC"
  printf '     %s5)%s Alpine 3.22        %s极小占用%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '     %s6)%s Windows            %s需填镜像名%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '     %s7)%s DD 自定义镜像\n' "$GREEN" "$NC"
  printf '     %s8)%s 只看完整用法（不执行）\n' "$CYAN" "$NC"
  printf '     %s0)%s 返回\n' "$RED" "$NC"
  echo
  ask "  请选择 [0-8]: " c
  case "${c:-0}" in
    1) os=debian; ver=12 ;;
    2) os=debian; ver=13 ;;
    3) os=ubuntu; ver=24.04 ;;
    4) os=ubuntu; ver=22.04 ;;
    5) os=alpine; ver=3.22 ;;
    6) os=windows ;;
    7) os=dd ;;
    8) run_remote "reinstall.sh（用法）" "$url?$(date +%s)" sh
       return 0 ;;
    *) return 0 ;;
  esac

  if [ "$os" = "windows" ]; then
    if ! ask "  Windows 镜像名（例：windows 11 professional）: " winname; then
      err "输入结束，已取消"; return 1
    fi
    [ -z "$winname" ] && { err "必须填写镜像名"; return 1; }
    if ! ask "  语言 [回车默认 zh-cn]: " wlang; then
      err "输入结束，已取消"; return 1
    fi
    wlang="${wlang:-zh-cn}"
  elif [ "$os" = "dd" ]; then
    if ! ask "  镜像直链（raw/vhd/tar/gz/xz/zst）: " img; then
      err "输入结束，已取消"; return 1
    fi
    [ -z "$img" ] && { err "必须填写镜像地址"; return 1; }
  fi

  if [ "$os" != "dd" ]; then
    if ! ask "  登录密码（回车 = 自动生成随机强密码）: " pw; then
      err "输入结束，已取消"; return 1
    fi
    if [ -z "$pw" ]; then
      pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
      echo
      ok "已生成随机密码：${BOLD}${YELLOW}$pw${NC}"
      warn "请立刻记下；执行重装前会写入 /root/reinstall-credentials.txt"
    fi
    if ! ask "  自定义 SSH 端口（回车 = 默认 22）: " sport; then
      err "输入结束，已取消"; return 1
    fi
    if [ -n "$sport" ]; then
      if ! [ "$sport" -ge 1 ] 2>/dev/null || [ "$sport" -gt 65535 ] 2>/dev/null; then
        err "SSH 端口不合法：$sport（1-65535）"; return 1
      fi
    fi
    if ! ask "  SSH 公钥（可留空）: " key; then
      err "输入结束，已取消"; return 1
    fi
  fi

  echo
  hr
  printf '  %s即将执行：%s\n' "$BOLD" "$NC"
  case "$os" in
    windows) printf '    reinstall.sh windows --image-name="%s" --lang=%s --password=***\n' "$winname" "$wlang" ;;
    dd)      printf '    reinstall.sh dd --img="%s"\n' "$img" ;;
    *)       printf '    reinstall.sh %s %s --password=***\n' "$os" "$ver" ;;
  esac
  hr
  printf '  %s%s机器上所有数据将被清空，且不可恢复%s\n' "$RED" "$BOLD" "$NC"
  printf '  %s要放弃，现在就按 Ctrl+C%s\n' "$DIM" "$NC"
  echo
  if ! ask "  确认继续请输入 ${BOLD}REINSTALL${NC} 并回车：" ans; then
    err "输入结束，已取消"; return 1
  fi
  if [ "$ans" != "REINSTALL" ]; then warn "已取消（输入不匹配）"; return 0; fi

  # 重装脚本通常会中途重启，退出码非 0 甚至根本回不到这里；
  # 所以在执行前无条件再显示一次凭据，并落到仅 root 可读的文件里。
  if [ -n "$pw" ]; then
    local cred="/root/reinstall-credentials.txt" old_umask
    old_umask="$(umask)"
    umask 077
    {
      printf '# reinstall credentials -- %s\n' "$(date '+%F %T %z')"
      printf 'os=%s %s\n' "$os" "$ver"
      printf 'password=%s\n' "$pw"
      [ -n "$sport" ] && printf 'ssh_port=%s\n' "$sport"
      printf '\n'
    } > "$cred" 2>/dev/null || warn "凭据文件写入失败：$cred（请立刻记下上方密码）"
    chmod 600 "$cred" 2>/dev/null || true
    umask "$old_umask"
    echo
    printf '  %s登录信息（执行后不会再显示，务必现在保存）%s\n' "$BOLD" "$NC"
    info "  密码: $pw"
    [ -n "$sport" ] && info "  端口: $sport"
    [ -n "$key" ]   && info "  已配置 SSH 公钥"
    dim "  同时已写入 $cred（仅 root 可读；重装会清空该文件）"
    echo
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/vpstool-reinstall.$$.XXXXXX.sh")" || { err "无法创建临时文件"; return 1; }
  _register_tmp "$tmp"
  step "下载 reinstall.sh"
  if ! fetch "$url?$(date +%s)" "$tmp"; then
    err "下载失败"; rm -f "$tmp"; return 1
  fi
  if [ ! -s "$tmp" ] || ! grep -qF -- '### BEGIN reinstall.sh ###' "$tmp"; then
    err "下载内容不是 reinstall.sh，拒绝执行"; rm -f "$tmp"; return 1
  fi
  ok "已下载 $(wc -c < "$tmp") 字节"

  local -a args=()
  case "$os" in
    windows) args=(windows "--image-name=$winname" "--lang=$wlang") ;;
    dd)      args=(dd "--img=$img") ;;
    *)       args=("$os" "$ver") ;;
  esac
  [ -n "$pw" ]    && args+=("--password=$pw")
  [ -n "$sport" ] && args+=("--ssh-port=$sport")
  [ -n "$key" ]   && args+=("--ssh-key=$key")

  step "开始重装（请勿中断）"
  dim "脚本会自行下载系统镜像并重启进入安装环境"
  hr
  if [ "$HAVE_TTY" = 1 ]; then
    sh "$tmp" "${args[@]}" < /dev/tty
  else
    sh "$tmp" "${args[@]}"
  fi
  rc=$?
  hr
  if [ "$rc" -eq 0 ]; then
    ok "重装脚本执行完毕，机器即将重启"
    if [ -n "$pw" ]; then
      echo
      printf '  %s登录信息（务必保存）%s\n' "$BOLD" "$NC"
      info "  密码: $pw"
      [ -n "$sport" ] && info "  端口: $sport"
      [ -n "$key" ]   && info "  已配置 SSH 公钥"
    fi
  else
    warn "退出码 $rc，请检查上方输出"
  fi
  rm -f "$tmp"
}

# 清掉 rc 文件里历史的 qc 别名（先备份再删）
#   _clean_qc_alias          → 装的时候用，warn 提醒备份过
#   _clean_qc_alias quiet    → 卸的时候用，只 info 一句
_clean_qc_alias() {
  local quiet="${1:-}" rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    grep -qE "^[[:space:]]*alias[[:space:]]+${CMD_NAME}=" "$rc" 2>/dev/null || continue
    cp -a "$rc" "$rc.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
    sed -i -E "/^[[:space:]]*alias[[:space:]]+${CMD_NAME}=/d" "$rc"
    if [ "$quiet" = "quiet" ]; then
      info "已清理 $rc 中的别名（备份 .bak-*）"
    else
      warn "已从 $rc 中移除旧的 ${CMD_NAME} 别名（备份 .bak-*）"
    fi
  done
  return 0
}

act_install_self() {
  step "安装 ${CMD_NAME} 快捷命令"
  info "安装位置: $INSTALL_PATH"
  info "装好后在任意 shell（bash / zsh / fish 均可）直接输入 ${BOLD}${CMD_NAME}${NC} 即可打开本菜单"
  echo

  local src=""
  # 判断当前是不是从真实文件运行（管道运行的话 $0 不是文件）
  if [ -f "$0" ] && [ -r "$0" ] && head -n1 "$0" 2>/dev/null | grep -q '^#!'; then
    src="$0"
    # 从已安装的 qc 跑进来时强制走网络下载，否则永远无法自我更新。
    # 直接 cp 到自身会报 "are the same file"，所以这里先清空 src。
    if [ "$src" -ef "$INSTALL_PATH" ] 2>/dev/null; then
      src=""
      info "当前从已安装的 ${CMD_NAME} 运行，正在从网络拉取最新版更新"
    else
      info "来源: 当前文件  $src"
    fi
  else
    info "当前是管道方式运行，从网络下载最新版"
  fi

  mkdir -p /usr/local/bin || { err "无法创建 /usr/local/bin"; return 1; }

  if [ -n "$src" ]; then
    bash -n "$src" 2>/dev/null || { err "脚本语法检查不通过，拒绝安装"; return 1; }
    # 先拷到临时文件再原子替换 —— 复制中途失败不会毁掉已存在的安装（与网络路径一致）
    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/vps-toolbox.XXXXXX")" || { err "无法创建临时文件"; return 1; }
    cp -f "$src" "$tmp" || { err "复制失败"; rm -f "$tmp"; return 1; }
    chmod +x "$tmp"
    mv -f "$tmp" "$INSTALL_PATH" || { err "写入 $INSTALL_PATH 失败"; rm -f "$tmp"; return 1; }
  else
    # 先下到临时文件，验证通过再原子替换 —— 失败时不会毁掉已存在的安装
    local u got=0 tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/vps-toolbox.XXXXXX")" || { err "无法创建临时文件"; return 1; }
    for u in "${SELF_URLS[@]}"; do
      dim "  尝试 $u"
      if fetch "$u" "$tmp" 2>/dev/null \
         && [ -s "$tmp" ] \
         && head -n1 "$tmp" 2>/dev/null | grep -q '^#!' \
         && grep -qF -- 'CMD_NAME="qc"' "$tmp" \
         && bash -n "$tmp" 2>/dev/null; then
        ok "  这个源可用"
        got=1
        break
      fi
      dim "  不可用，换下一个"
    done
    if [ "$got" != 1 ]; then
      rm -f "$tmp"
      err "所有下载源都失败"
      if [ -f "$INSTALL_PATH" ]; then
        warn "已保留原有的 $INSTALL_PATH，未做改动"
      fi
      return 1
    fi
    chmod +x "$tmp"
    mv -f "$tmp" "$INSTALL_PATH" || { rm -f "$tmp"; err "写入 $INSTALL_PATH 失败"; return 1; }
  fi
  chmod +x "$INSTALL_PATH"

  if [ -s "$INSTALL_PATH" ] && head -n1 "$INSTALL_PATH" | grep -q '^#!' \
     && grep -qF -- 'CMD_NAME="qc"' "$INSTALL_PATH" \
     && bash -n "$INSTALL_PATH" 2>/dev/null; then
    ok "已安装：$INSTALL_PATH  ($(wc -c < "$INSTALL_PATH") 字节)"
  else
    err "安装异常：文件内容不是有效脚本"
    rm -f "$INSTALL_PATH"
    return 1
  fi

  # 清掉历史上可能存在的同名 alias，避免和命令冲突
  _clean_qc_alias

  echo
  if command -v "$CMD_NAME" >/dev/null 2>&1; then
    ok "验证通过：$(command -v "$CMD_NAME")"
    info "现在直接输入 ${BOLD}${CMD_NAME}${NC} 就能打开菜单"
  else
    warn "已安装，但当前 PATH 里找不到 /usr/local/bin，请检查 PATH"
  fi
}

act_uninstall_self() {
  step "卸载 ${CMD_NAME} 快捷命令"
  if [ -f "$INSTALL_PATH" ]; then
    rm -f "$INSTALL_PATH" && ok "已删除 $INSTALL_PATH"
  else
    info "$INSTALL_PATH 不存在"
  fi
  _clean_qc_alias quiet
}

act_qc_menu() {
  local a
  step "${CMD_NAME} 快捷命令"
  if [ -f "$INSTALL_PATH" ]; then
    ok "当前状态：已安装  ($INSTALL_PATH)"
    info "在任何地方输入 ${BOLD}${CMD_NAME}${NC} 即可打开菜单"
  else
    warn "当前状态：未安装"
    info "安装后可在任意 shell 直接输入 ${CMD_NAME} 打开菜单"
  fi
  echo
  info "  1) 安装 / 更新为最新版"
  info "  2) 卸载"
  info "  0) 返回"
  echo
  ask "  请选择 [0-2]: " a
  case "${a:-0}" in
    1) act_install_self ;;
    2) act_uninstall_self ;;
    *) return 0 ;;
  esac
}

# ================================================================ 菜单

banner() {
  [ "$HAVE_TTY" = 1 ] && clear 2>/dev/null || true
  printf '%s\n' "${CYAN}${BOLD}"
  printf '   ╔══════════════════════════════════════════════════════════╗\n'
  printf '   ║              VPS 常用工具箱   v%-4s                      ║\n' "$VERSION"
  printf '   ║        基础环境 · 网络调优 · 安全 · 代理 · 测评           ║\n'
  printf '   ╚══════════════════════════════════════════════════════════╝\n'
  printf '%s\n' "${NC}"
  printf '  %s主机%s %s   %s内核%s %s\n' "$DIM" "$NC" "$(hostname)" "$DIM" "$NC" "$(uname -r)"
  printf '  %s系统%s %s\n' "$DIM" "$NC" "$( (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-未知}") )"
  printf '  %s时间%s %s\n' "$DIM" "$NC" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  if [ -f "$INSTALL_PATH" ]; then
    printf '  %s✔%s %s 命令已安装，任何地方输入 %s%s%s 即可打开本菜单\n' \
      "$GREEN" "$NC" "$CMD_NAME" "$BOLD" "$CMD_NAME" "$NC"
  else
    printf '  %s提示：选 19 安装 %s%s%s 命令，以后直接敲 %s%s%s 进菜单%s\n' \
      "$DIM" "$BOLD" "$CMD_NAME" "$NC" "$BOLD" "$CMD_NAME" "$NC" "$NC"
  fi
  echo
}

menu() {
  printf '  %s%2s)%s  一键基础初始化\n' "$CYAN$BOLD" "1" "$NC"
  printf '  %s%2s)%s  BBR v3 优化脚本\n' "$CYAN$BOLD" "2" "$NC"
  printf '  %s%2s)%s  TCP 调优\n' "$CYAN$BOLD" "3" "$NC"
  printf '  %s%2s)%s  BBRv3 内核\n' "$CYAN$BOLD" "5" "$NC"
  printf '  %s%2s)%s  SSH 安全配置脚本\n' "$CYAN$BOLD" "6" "$NC"
  printf '  %s%2s)%s  WARP (warp-go)\n' "$CYAN$BOLD" "7" "$NC"
  printf '  %s%2s)%s  IPv6 管理\n' "$CYAN$BOLD" "8" "$NC"
  printf '  %s%2s)%s  Docker 安装\n' "$CYAN$BOLD" "9" "$NC"
  printf '  %s%2s)%s  Emby 反代\n' "$CYAN$BOLD" "10" "$NC"
  printf '  %s%2s)%s  Flyx 面板\n' "$CYAN$BOLD" "11" "$NC"
  printf '  %s%2s)%s  妙妙屋X 安装\n' "$CYAN$BOLD" "12" "$NC"
  printf '  %s%2s)%s  Komari Lite\n' "$CYAN$BOLD" "13" "$NC"
  printf '  %s%2s)%s  NodeQuality\n' "$CYAN$BOLD" "14" "$NC"
  printf '  %s%2s)%s  TcpQuality\n' "$CYAN$BOLD" "15" "$NC"
  printf '  %s%2s)%s  iperf3 服务端\n' "$CYAN$BOLD" "16" "$NC"
  printf '  %s%2s)%s  aria2 下载工具\n' "$CYAN$BOLD" "17" "$NC"
  printf '  %s%2s)%s  查看系统状态汇总\n' "$CYAN$BOLD" "18" "$NC"
  printf '  %s%2s)%s  安装/卸载 qc 快捷命令\n' "$CYAN$BOLD" "19" "$NC"
  printf '  %s%2s)%s  %s重装系统 (DD)%s\n' "$CYAN$BOLD" "20" "$NC" "$RED" "$NC"
  printf '  %s%2s)%s  %s退出%s\n' "$CYAN$BOLD" "0" "$NC" "$DIM" "$NC"
  hr
}

main() {
  local choice
  while true; do
    banner
    menu
    if ! ask "  ${BOLD}请输入选项${NC} [0-20]: " choice; then
      printf '\n  %s输入结束，退出%s\n\n' "$CYAN" "$NC"; exit 0
    fi
    case "${choice:-}" in
      1)  act_bootstrap ;;
      2)  act_net_tune ;;
      3)  act_tcpfit ;;
      4)  warn "第 4 项（加 swap）已移除"; pause ;;
      5)  act_bbrv3 ;;
      6)  act_keysh ;;
      7)  act_warpgo ;;
      8)  act_ipv6 ;;
      9)  act_docker ;;
      10) act_embyproxy ;;
      11) act_flyx ;;
      12) act_miaomiaowux ;;
      13) act_lite ;;
      14) act_nodequality ;;
      15) act_tcpquality ;;
      16) act_iperf3 ;;
      17) act_aria2 ;;
      18) act_status ;;
      19) act_qc_menu ;;
      20) act_reinstall ;;
      0|q|Q|quit|exit) printf '\n  %s再见%s\n\n' "$CYAN" "$NC"; exit 0 ;;
      "") continue ;;
      *)  err "无效选项：$choice" ;;
    esac
    pause
  done
}

usage() {
  cat <<'USAGE'
VPS 常用工具箱

用法:
  bash vps-toolbox.sh              打开交互菜单
  bash vps-toolbox.sh <命令>       直接执行某一项

命令:
  status        查看系统状态汇总
  bootstrap     一键基础初始化（依赖 + 时区 + journald 日志）
  tunenet       net-tcp-tune 调优
  tcpfit        tcpfit 调优
  bbrv3         BBRv3 内核（byJoey/Actions-bbr-v3，装内核）
  key           SSH 加固 (key.sh)
  emby          emby-rp —— Emby HTTPS 反代（Caddy/Nginx，含前后端分离）
  lite          Komari Lite Agent
  nodequality   NodeQuality 测评
  tcpquality    TcpQuality 测试
  iperf3        iperf3 服务端（状态 / 启动 / 停止，用完可关）
  aria2         aria2 下载工具（安装 / 下载 / 进度 / 清除 / 网页下载）
  warp          WARP (warp-go) —— 给纯 IPv6 机器加 IPv4 出口
  ipv6          IPv6 管理 —— 临时/永久禁用或恢复
  flyx          Flyx 面板 —— 一键安装脚本（kure29/flyx）
  mmwx          妙妙屋X 主控安装（一键安装脚本）
  docker        安装 Docker（官方脚本）
  qc            安装/卸载 qc 快捷命令
  install       安装 qc 快捷命令，装完自动进入菜单
  uninstall     卸载 qc 快捷命令
  reinstall     重装系统 (会清空机器)
  help          显示本帮助
USAGE
}

case "${1:-}" in
  ""|-m|--menu|menu)      main ;;
  status)                 act_status ;;
  bootstrap|init)         act_bootstrap ;;
  tunenet|bbr)            act_net_tune ;;
  tcpfit)                 act_tcpfit ;;
  bbrv3|bbr3|kernel)      act_bbrv3 ;;
  key|key.sh)             act_keysh ;;
  emby|embyproxy|ep)      act_embyproxy ;;
  lite|komari)            act_lite ;;
  nodequality|nq)         act_nodequality ;;
  tcpquality|tq)          act_tcpquality ;;
  iperf3|iperf)           act_iperf3 ;;
  aria2)                  act_aria2 ;;
  warp|warpgo|warp-go)    act_warpgo ;;
  ipv6|ipv6mgr)           act_ipv6 ;;
  flyx|flyxpanel) act_flyx ;;
  mmwx|miaomiaowux) act_miaomiaowux ;;
  docker|dockerd)         act_docker ;;
  qc|cmd)                 act_qc_menu ;;
  install)
    # 装完直接进入菜单，省得再敲一次 qc
    if act_install_self; then
      if [ "$HAVE_TTY" = 1 ]; then
        printf '\n'
        info "正在打开菜单 ..."
        sleep 1
        exec "$INSTALL_PATH"
      else
        printf '\n  %s已安装。之后输入 %s 即可打开菜单%s\n\n' "$CYAN" "$CMD_NAME" "$NC"
      fi
    fi
    ;;
  uninstall)              act_uninstall_self ;;
  reinstall|dd)           act_reinstall ;;
  -h|--help|help)         usage ;;
  *) printf '%s\n' "未知参数: $1"; echo; usage; exit 1 ;;
esac
