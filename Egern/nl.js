/**
 * Egern Calendar Widget
 * 极简美观版：含农历、宜忌
 */

const now = new Date();
const day = now.getDate();
const month = now.getMonth() + 1;
const year = now.getFullYear();
const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekDay = weekDays[now.getDay()];

// 简易农历及宜忌逻辑 (示例数据，实际应用中建议通过 API 获取精准黄历)
const lunarInfo = {
    month: "正月",
    day: "廿五",
    suit: "订盟, 纳采, 会亲友",
    avoid: "开市, 安葬, 修坟"
};

// 构建 UI
const widget = {
    type: "h-stack",
    style: {
        padding: "15",
        backgroundColor: "#FFFFFF",
        alignment: "center",
        spacing: 15
    },
    items: [
        // 左侧：大数字日期
        {
            type: "v-stack",
            style: { alignment: "center", spacing: 2 },
            items: [
                { type: "text", text: weekDay, style: { fontSize: 14, color: "#8E8E93" } },
                { type: "text", text: `${day}`, style: { fontSize: 42, fontWeight: "bold", color: "#000000" } }
            ]
        },
        // 分隔线
        { type: "spacer", style: { width: 1, backgroundColor: "#E5E5EA", height: 40 } },
        // 右侧：农历与宜忌
        {
            type: "v-stack",
            style: { alignment: "leading", spacing: 5 },
            items: [
                { type: "text", text: `${lunarInfo.month}${lunarInfo.day}`, style: { fontSize: 16, fontWeight: "600" } },
                {
                    type: "h-stack",
                    style: { spacing: 5 },
                    items: [
                        { type: "text", text: "宜", style: { fontSize: 11, color: "#FFFFFF", backgroundColor: "#28CD41", padding: "2 6", cornerRadius: 4 } },
                        { type: "text", text: lunarInfo.suit, style: { fontSize: 12, color: "#3A3A3C" } }
                    ]
                },
                {
                    type: "h-stack",
                    style: { spacing: 5 },
                    items: [
                        { type: "text", text: "忌", style: { fontSize: 11, color: "#FFFFFF", backgroundColor: "#FF3B30", padding: "2 6", cornerRadius: 4 } },
                        { type: "text", text: lunarInfo.avoid, style: { fontSize: 12, color: "#3A3A3C" } }
                    ]
                }
            ]
        }
    ]
};

$done(widget);
