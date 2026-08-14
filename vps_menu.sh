#!/usr/bin/env bash
# ============================================================
#  VPS 常用脚本整合菜单
#  用法: chmod +x vps_menu.sh && ./vps_menu.sh
#  建议以 root 运行；非 root 时自动使用 sudo
# ============================================================

# ---------- 颜色定义 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'   # No Color

# ---------- sudo 处理 ----------
if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

# ---------- 脚本下载地址（qc 快捷命令安装时使用） ----------
SCRIPT_URL="https://raw.githubusercontent.com/Masamisuki/Tool/refs/heads/main/vps_menu.sh"

# ---------- 分隔线 ----------
hr() {
    printf '%*s\n' "${COLUMNS:-60}" '' | tr ' ' '='
}

# ============================================================
#  功能函数
# ============================================================

# 1. 安装基础依赖
install_base() {
    echo -e "${GREEN}==> 安装基础依赖 (sudo / curl / wget)${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update && $SUDO apt-get install -y sudo curl wget
    elif command -v dnf >/dev/null 2>&1; then
        $SUDO dnf install -y sudo curl wget
    elif command -v yum >/dev/null 2>&1; then
        $SUDO yum install -y sudo curl wget
    elif command -v apk >/dev/null 2>&1; then
        $SUDO apk add sudo curl wget
    else
        echo -e "${RED}未识别包管理器，请手动安装 sudo/curl/wget。${NC}"
    fi
}

# 2. 安装 BBR v3
install_bbr_v3() {
    echo -e "${GREEN}==> 安装 BBR v3 优化脚本（含别名 bbr）${NC}"
    bash <(curl -q -fsSL "https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/install-alias.sh?$(date +%s)")
    # bbr 是别名，只在交互式 shell 中展开，这里模拟新开终端执行
    bash -ic 'bbr'
}

# 3. 安装 Snell
install_snell() {
    echo -e "${GREEN}==> 安装 Snell${NC}"
    wget -O snell.sh --no-check-certificate https://git.io/Snell.sh && chmod +x snell.sh && ./snell.sh
}

# 4. 安装 OU-SSH
install_ou_ssh() {
    echo -e "${GREEN}==> 安装 OU-SSH${NC}"
    bash <(curl -sL https://raw.githubusercontent.com/cshaizhihao/OU-SSH/main/install.sh)
}

# 5. 安装 tcpfit
install_tcpfit() {
    echo -e "${GREEN}==> 安装 tcpfit${NC}"
    bash <(curl -fsSL https://raw.githubusercontent.com/Kylin010/tcpfit/main/tcpfit.sh)
}

# 6. 安装 Realm 一键转发
install_realm() {
    echo -e "${GREEN}==> 安装 Realm 一键转发${NC}"
    curl -L https://raw.githubusercontent.com/wcwq98/realm/refs/heads/main/realm.sh -o realm.sh && chmod +x realm.sh && ./realm.sh
}

# 7. TQ 测试（TCP 质量）
run_tq() {
    echo -e "${GREEN}==> TQ 测试（TCP 质量）${NC}"
    bash <(curl -fsSL https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh)
}

# 8. NQ 测试（NodeQuality）
run_nq() {
    echo -e "${GREEN}==> NQ 测试（NodeQuality）${NC}"
    bash <(curl -sL https://run.NodeQuality.com)
}

# 9. 安装 VLESS
install_vless() {
    echo -e "${GREEN}==> 安装 VLESS${NC}"
    wget -O vless-server.sh https://raw.githubusercontent.com/mozisen/surge/main/vless-server.sh && chmod +x vless-server.sh && bash vless-server.sh
}

# 10. 设置时区为上海
set_timezone() {
    echo -e "${GREEN}==> 设置时区为 Asia/Shanghai${NC}"
    $SUDO timedatectl set-timezone Asia/Shanghai
    timedatectl
}

# 11. 限制 systemd 日志大小
limit_journal() {
    echo -e "${GREEN}==> 限制 systemd 日志大小（总量 500M，单文件 50M）${NC}"
    $SUDO journalctl --vacuum-size=500M
    $SUDO sed -i -E 's/^#?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
    $SUDO sed -i -E 's/^#?SystemMaxFileSize=.*/SystemMaxFileSize=50M/' /etc/systemd/journald.conf
    $SUDO systemctl restart systemd-journald
    echo -e "${GREEN}==> 日志限制配置完成${NC}"
}

# 12. 安装 qc 快捷命令（root 界面输入 qc 快速进入本菜单）
setup_qc() {
    local target="${HOME}/vps_menu.sh"
    echo -e "${GREEN}==> 安装 qc 快捷命令${NC}"
    # 1. 下载最新脚本到固定位置
    if ! curl -fsSL "$SCRIPT_URL" -o "$target"; then
        echo -e "${RED}==> 下载脚本失败，请检查网络或 SCRIPT_URL。${NC}"
        return 1
    fi
    chmod +x "$target"
    # 2. 写入 qc 函数到 ~/.bashrc（去重）
    if grep -q 'qc()' ~/.bashrc 2>/dev/null; then
        echo -e "${YELLOW}==> ~/.bashrc 中已存在 qc 定义，跳过写入${NC}"
    else
        cat >> ~/.bashrc <<'EOF'

# === vps_menu qc 快捷命令 START ===
qc() { bash "${HOME}/vps_menu.sh"; }
# === vps_menu qc 快捷命令 END ===
EOF
        echo -e "${GREEN}==> 已写入 qc 函数到 ~/.bashrc${NC}"
    fi
    # 3. 立即生效
    source ~/.bashrc 2>/dev/null || true
    echo -e "${GREEN}==> 完成！重新登录或新开终端后，输入 qc 即可进入管理界面${NC}"
}

# 13. 完全卸载本管理脚本（无残留）
uninstall() {
    echo -e "${YELLOW}==> 即将完全卸载 VPS 管理脚本${NC}"
    read -rp "确认卸载？将删除脚本文件和 ~/.bashrc 中的 qc 命令 [y/N]: " confirm
    case "$confirm" in
        y|Y|yes|YES|Yes)
            # 1. 清理 ~/.bashrc 中的 qc 相关内容
            if [ -f ~/.bashrc ]; then
                sed -i '/# === vps_menu qc 快捷命令 START ===/,/# === vps_menu qc 快捷命令 END ===/d' ~/.bashrc
                sed -i '/^# 快速进入 VPS 管理菜单$/d' ~/.bashrc
                sed -i '/^qc() {/d' ~/.bashrc
            fi
            # 2. 删除脚本文件
            rm -f ~/vps_menu.sh
            echo -e "${GREEN}==> 卸载完成：已清理 ~/.bashrc 和 ~/vps_menu.sh，无残留${NC}"
            echo -e "${GREEN}==> 再见！${NC}"
            exit 0
            ;;
        *)
            echo -e "${YELLOW}==> 已取消卸载${NC}"
            ;;
    esac
}

# ============================================================
#  菜单
# ============================================================
show_menu() {
    clear
    hr
    echo -e "${CYAN}              我的 VPS 管理菜单${NC}"
    hr
    echo -e " ${YELLOW} 1${NC}. 安装基础依赖 (sudo / curl / wget)"
    echo -e " ${YELLOW} 2${NC}. 安装 BBR v3 优化脚本"
    echo -e " ${YELLOW} 3${NC}. 安装 Snell"
    echo -e " ${YELLOW} 4${NC}. 安装 OU-SSH"
    echo -e " ${YELLOW} 5${NC}. 安装 tcpfit"
    echo -e " ${YELLOW} 6${NC}. 安装 Realm 一键转发"
    echo -e " ${YELLOW} 7${NC}. TQ 测试（TCP 质量）"
    echo -e " ${YELLOW} 8${NC}. NQ 测试（NodeQuality）"
    echo -e " ${YELLOW} 9${NC}. 安装 VLESS"
    echo -e "${YELLOW}10${NC}. 设置时区为上海"
    echo -e "${YELLOW}11${NC}. 限制 systemd 日志大小"
    echo -e "${YELLOW}12${NC}. 安装 qc 快捷命令（root 界面输入 qc 进菜单）"
    echo -e "${YELLOW}13${NC}. 完全卸载本管理脚本（无残留）"
    echo -e " ${YELLOW} 0${NC}. 退出"
    hr
}

# ============================================================
#  主循环
# ============================================================
while true; do
    show_menu
    read -rp "请输入序号 [0-13]: " choice
    case "$choice" in
        1)  install_base ;;
        2)  install_bbr_v3 ;;
        3)  install_snell ;;
        4)  install_ou_ssh ;;
        5)  install_tcpfit ;;
        6)  install_realm ;;
        7)  run_tq ;;
        8)  run_nq ;;
        9)  install_vless ;;
        10) set_timezone ;;
        11) limit_journal ;;
        12) setup_qc ;;
        13) uninstall ;;
        0)  echo -e "${GREEN}再见！${NC}"; exit 0 ;;
        *)  echo -e "${RED}无效输入，请重新选择。${NC}" ;;
    esac
    echo
    read -rp "按回车键返回主菜单..." _
done
