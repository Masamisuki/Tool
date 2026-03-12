/**
 * Egern 现代黄历组件
 * 特点：极简设计、动态颜色、宜忌清晰
 */

const now = new Date();

// --- 模拟农历及黄历数据 (由于Egern环境下无法引用大型库，通常建议对接API或使用简化算法) ---
// 此处演示基础逻辑，实际使用中"宜/忌"建议通过简单的日期哈希或内置算法生成，保持轻量
const lunarDate = "正月初十"; // 示例
const suit = ["开光", "求医", "治病"];
const avoid = ["盖屋", "破土", "动土"];

// --- 布局样式变量 ---
const padding = 12;
const cornerRadius = 15;
const accentColor = new Color("#D32F2F"); // 典雅红

async function createWidget() {
    let w = new ListWidget();
    w.backgroundColor = new Color("#FDFCF8"); // 宣纸色背景
    w.setPadding(padding, padding, padding, padding);

    // 1. 顶部：月份与星期
    let headerStack = w.addStack();
    headerStack.centerAlignContent();
    
    let monthText = headerStack.addText(`${now.getMonth() + 1}月`);
    monthText.font = Font.systemFont(14);
    monthText.textColor = Color.gray();
    
    headerStack.addSpacer();
    
    let dayOfWeek = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
    let weekText = headerStack.addText(dayOfWeek);
    weekText.font = Font.boldSystemFont(14);
    weekText.textColor = accentColor;

    w.addSpacer(4);

    // 2. 中间：大数字日期
    let dayText = w.addText(`${now.getDate()}`);
    dayText.font = Font.boldSystemFont(42);
    dayText.centerAlignText();
    dayText.textColor = new Color("#333333");

    // 3. 农历显示
    let lunarText = w.addText(lunarDate);
    lunarText.font = Font.systemFont(12);
    lunarText.centerAlignText();
    lunarText.textColor = Color.gray();
    lunarText.textOpacity = 0.8;

    w.addSpacer(8);
    
    // 4. 宜忌区域 (卡片式布局)
    let infoStack = w.addStack();
    infoStack.layoutHorizontally();
    infoStack.spacing = 8;

    // 宜
    let suitStack = infoStack.addStack();
    suitStack.layoutVertically();
    suitStack.backgroundColor = new Color("#E8F5E9");
    suitStack.setPadding(4, 8, 4, 8);
    suitStack.cornerRadius = 6;
    
    let suitLabel = suitStack.addText("宜");
    suitLabel.font = Font.boldSystemFont(10);
    suitLabel.textColor = new Color("#2E7D32");
    suitStack.addText(suit.join(" ")).font = Font.systemFont(10);

    // 忌
    let avoidStack = infoStack.addStack();
    avoidStack.layoutVertically();
    avoidStack.backgroundColor = new Color("#FFEBEE");
    avoidStack.setPadding(4, 8, 4, 8);
    avoidStack.cornerRadius = 6;
    
    let avoidLabel = avoidStack.addText("忌");
    avoidLabel.font = Font.boldSystemFont(10);
    avoidLabel.textColor = new Color("#C62828");
    avoidStack.addText(avoid.join(" ")).font = Font.systemFont(10);

    return w;
}

// 渲染组件
const widget = await createWidget();
Script.setWidget(widget);
Script.complete();
