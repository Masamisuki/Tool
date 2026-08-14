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
    echo -e " ${YELLOW} 0${NC}. 退出"
    hr
}

# ============================================================
#  主循环
# ============================================================
while true; do
    show_menu
    read -rp "请输入序号 [0-11]: " choice
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
        0)  echo -e "${GREEN}再见！${NC}"; exit 0 ;;
        *)  echo -e "${RED}无效输入，请重新选择。${NC}" ;;
    esac
    echo
    read -rp "按回车键返回主菜单..." _
done
