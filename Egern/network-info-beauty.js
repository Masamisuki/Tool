// network-info-minimal.js   ── 极简调试版，先确保能显示再说

async function createWidget(ctx) {
  // 先取最基本的信息，避免访问可能不存在的深层字段导致崩溃
  const family = ctx.widgetFamily || 'systemSmall';
  const wifi = ctx.device?.wifi?.ssid || '无 Wi-Fi';
  const ip = ctx.device?.ipv4?.address || '无 IP';
  const carrier = ctx.device?.cellular?.carrier || '';

  let title = carrier || wifi;
  if (!title || title === 'Wi-Fi') title = '网络信息';

  // 构建最简单的 widget（只用 text，避免 image/gradient 问题）
  const widget = {
    type: "widget",
    padding: family.includes('Small') ? 10 : 16,
    backgroundColor: "#1e293b",          // 深灰背景，确保可见
    children: [
      {
        type: "text",
        text: title,
        font: { size: "headline", weight: "bold" },   // 用文档出现过的值
        textColor: "#ffffff"
      },
      {
        type: "text",
        text: ip || '获取 IP 失败',
        font: { size: "body" },
        textColor: "#a5b4fc",
        padding: { top: 4 }
      },
      {
        type: "text",
        text: new Date().toLocaleTimeString('zh-CN', {hour12: false}),
        font: { size: "caption" },
        textColor: "#94a3b8",
        padding: { top: 8 }
      }
    ]
  };

  return widget;
}

// 关键：直接 return，不要用 $widget.setWidget
// Egern 文档里根本没有这个 API，之前是我想当然加的
return createWidget(ctx);
