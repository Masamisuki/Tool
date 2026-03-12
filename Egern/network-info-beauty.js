async function createWidget() {
  const family = ctx.widgetFamily || "systemSmall";

  // ── 网络信息 ──
  const wifiSSID   = ctx.device.wifi?.ssid   || "未连接";
  const localIP    = ctx.device.ipv4?.address || ctx.device.ipv6?.address || "无 IP";
  const carrier    = ctx.device.cellular?.carrier || ctx.device.cellular?.radio || "";
  const isWiFi     = wifiSSID !== "未连接" && wifiSSID !== "";

  let netType = carrier ? "蜂窝" : (isWiFi ? "Wi-Fi" : "无网络");
  let icon = isWiFi ? "wifi" : (carrier ? "cellularbars" : "wifi.slash");
  let iconColor = isWiFi ? "#34C759" : (carrier ? "#5856D6" : "#FF3B30");

  // 简单外网延迟测试（可选，如果超时就显示 —）
  let ping = "—";
  try {
    const t0 = Date.now();
    await ctx.http.get("https://www.apple.com/library/test/success.html", { timeout: 4000 });
    const ms = Date.now() - t0;
    ping = ms < 9999 ? ms.toString() : ">9s";
  } catch {}

  // ── Widget DSL ──
  const widget = {
    type: "widget",
    padding: family.includes("Small") ? 12 : 16,
    backgroundGradient: {
      type: "linear",
      colors: ["#0f172a", "#1e293b", "#334155"],
      stops: [0, 0.5, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 }
    },
    borderRadius: "auto",
    children: [
      // 标题 + 图标
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        gap: 8,
        children: [
          {
            type: "image",
            src: `sf-symbol:${icon}`,
            width: family.includes("Small") ? 20 : 28,
            height: family.includes("Small") ? 20 : 28,
            color: iconColor
          },
          {
            type: "text",
            text: netType,
            font: { size: family.includes("Small") ? "subheadline" : "title3", weight: "semibold" },
            textColor: "#f1f5f9"
          }
        ]
      },

      // 分隔（中大尺寸）
      ...(family.includes("Small") ? [] : [{
        type: "spacer",
        length: 4
      }, {
        type: "stack",
        height: 1,
        backgroundColor: "#47556980"
      }]),

      // 主信息
      {
        type: "stack",
        gap: family.includes("Small") ? 4 : 8,
        children: [
          {
            type: "text",
            text: carrier || wifiSSID,
            font: { size: "caption1", weight: "medium" },
            textColor: "#94a3b8",
            maxLines: 1
          },
          {
            type: "stack",
            direction: "row",
            alignItems: "center",
            gap: 12,
            children: [
              {
                type: "text",
                text: localIP,
                font: { size: family.includes("Small") ? "caption1" : "callout", family: "Menlo" },
                textColor: "#cbd5e1"
              },
              {
                type: "spacer"
              },
              {
                type: "text",
                text: ping === "—" ? "—" : ping + "ms",
                font: { size: "caption2", weight: "semibold", family: "Menlo" },
                textColor: ping === "—" ? "#64748b" : "#10b981"
              }
            ]
          }
        ]
      }
    ]
  };

  return widget;
}

$widget.setWidget(await createWidget());
