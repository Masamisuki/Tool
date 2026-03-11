/**
 * Egern 网络信息小组件
 * 参考 net-lsp-x 逻辑，展示：本地 IP -> 入口 -> 落地 IP
 */

async function main() {
    let results = {
        local: { ip: "未知", loc: "获取中..." },
        proxy: { ip: "获取中...", loc: "获取中...", node: "未检测" }
    };

    try {
        // 1. 获取本地直连出口信息 (使用直连 policy)
        const localRes = await fetch("http://ip-api.com/json/?lang=zh-CN", {
            headers: { "x-egern-policy": "DIRECT" } // 强制直连
        }).then(r => r.json()).catch(() => null);

        if (localRes) {
            results.local.ip = localRes.query;
            results.local.loc = `${localRes.regionName} ${localRes.city}`;
        }

        // 2. 获取当前代理落地信息
        const proxyRes = await fetch("http://ip-api.com/json/?lang=zh-CN")
            .then(r => r.json()).catch(() => null);

        if (proxyRes) {
            results.proxy.ip = proxyRes.query;
            results.proxy.loc = `${proxyRes.country} ${proxyRes.city}`;
        }

        // 3. 获取当前节点名称 (Egern 特有 API)
        const outbound = await $environment.outbound;
        results.proxy.node = outbound || "未知节点";

    } catch (e) {
        console.log("获取失败: " + e);
    }

    // 渲染 Egern 小组件
    $widget.set({
        title: "网络链路检测",
        content: `节点: ${results.proxy.node}`,
        icon: "network",
        backgroundColor: "#1c1c1e",
        url: "egern://", 
        items: [
            {
                title: "本地出口",
                content: results.local.ip,
                color: "#007AFF"
            },
            {
                title: "落地位置",
                content: results.proxy.loc,
                color: "#34C759"
            },
            {
                title: "落地 IP",
                content: results.proxy.ip,
                color: "#FF9500"
            }
        ]
    });
}

main().finally(() => $done());
