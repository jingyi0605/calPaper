/**
 * 算账稿纸 · 核心引擎单元测试
 * 运行：node tests/core.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const Core = require(path.join(__dirname, "..", "core.js"));

let pass = 0, fail = 0;
const failures = [];

function t(label, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(label + " → " + e.message);
  }
}

function ev(s) { return Core.evaluate(s); }

function rp(s) {
  const r = ev(s);
  assert(r.ok, `求值失败: "${s}"${r.error ? "（" + r.error + "）" : ""}`);
  return Core.resultPlain(r.value);
}

function rt(s) {
  const r = ev(s);
  assert(r.ok, `求值失败: "${s}"${r.error ? "（" + r.error + "）" : ""}`);
  return Core.resultText(r.value);
}

function mp(s) {
  const r = ev(s);
  assert(r.ok, `求值失败: "${s}"${r.error ? "（" + r.error + "）" : ""}`);
  return Core.moneyPlain(r.value);
}

function bad(s) {
  const r = ev(s);
  assert(!r.ok, `本应失败但成功了: "${s}"`);
}

/* ---------------- 基础运算（精确性） ---------------- */
t("0.1 + 0.2 = 0.3（无浮点误差）", () => assert.strictEqual(rp("0.1+0.2"), "0.3"));
t("1.1 * 1.1 = 1.21", () => assert.strictEqual(rp("1.1*1.1"), "1.21"));
t("123456789.123456789 × 2 精确", () => assert.strictEqual(rp("123456789.123456789*2"), "246913578.246913578"));
t("大整数相加", () => assert.strictEqual(rp("9007199254740993+1"), "9007199254740994"));
t("减法", () => assert.strictEqual(rp("1000-0.001"), "999.999"));
t("括号与优先级", () => assert.strictEqual(rp("(1+2)*3"), "9"));
t("幂运算 2^10", () => assert.strictEqual(rp("2^10"), "1024"));
t("右结合 2^3^2 = 512", () => assert.strictEqual(rp("2^3^2"), "512"));
t("负指数 2^-2 = 0.25", () => assert.strictEqual(rp("2^-2"), "0.25"));
t("一元负号优先级 -2^2 = -4", () => assert.strictEqual(rp("-2^2"), "-4"));
t("小数次幂 4^0.5 = 2", () => assert.strictEqual(rp("4^0.5"), "2"));
t("百分号 50% = 0.5", () => assert.strictEqual(rp("50%"), "0.5"));
t("100*5% = 5", () => assert.strictEqual(rp("100*5%"), "5"));
t("100+5% = 100.05", () => assert.strictEqual(rp("100+5%"), "100.05"));

/* ---------------- 除法精度 ---------------- */
t("10/4 = 2.5", () => assert.strictEqual(rp("10/4"), "2.5"));
t("1/3 保留 35 位", () => {
  const s = rp("1/3");
  assert(s.startsWith("0.33333333333333333333333333333333333"), s);
});
t("2/3 末位进位", () => {
  const s = rp("2/3");
  assert(s.startsWith("0.6666666666666666666666666666666666"), s);
  assert(s.endsWith("7"), s);
});
t("100/3 金额 = 33.33", () => assert.strictEqual(mp("100/3"), "33.33"));
t("100/3 结果前缀", () => {
  const s = rp("100/3");
  assert(s.startsWith("33.33333333333333333333333333333333"), s);
});

/* ---------------- 四舍五入（财务金额核心） ---------------- */
t("1.005 → 1.01（浮点陷阱）", () => assert.strictEqual(mp("1.005"), "1.01"));
t("1.004 → 1.00", () => assert.strictEqual(mp("1.004"), "1.00"));
t("1.005*100 → 100.50", () => assert.strictEqual(mp("1.005*100"), "100.50"));
t("-12.345 → -12.35（远离零）", () => assert.strictEqual(mp("-12.345"), "-12.35"));
t("2.5 → 2.50", () => assert.strictEqual(mp("2.5"), "2.50"));
t("0.005 → 0.01", () => assert.strictEqual(mp("0.005"), "0.01"));
t("-0.001 → 0.00（去掉负零）", () => assert.strictEqual(mp("-0.001"), "0.00"));
t("整数金额补两位 1234 → 1234.00", () => assert.strictEqual(mp("1234"), "1234.00"));
t("999999.995 → 1000000.00（进位）", () => assert.strictEqual(mp("999999.995"), "1000000.00"));

/* ---------------- 函数 ---------------- */
t("sqrt(16) = 4", () => assert.strictEqual(rp("sqrt(16)"), "4"));
t("sqrt(0.25) = 0.5", () => assert.strictEqual(rp("sqrt(0.25)"), "0.5"));
t("sqrt(2) 精度与金额", () => {
  assert(rp("sqrt(2)").startsWith("1.4142135623730950488"));
  assert.strictEqual(mp("sqrt(2)"), "1.41");
});
t("sqrt(-1) 报错", () => bad("sqrt(-1)"));
t("abs(-3) = 3", () => assert.strictEqual(rp("abs(-3)"), "3"));
t("round(2.5) = 3", () => assert.strictEqual(rp("round(2.5)"), "3"));
t("round(2.4) = 2", () => assert.strictEqual(rp("round(2.4)"), "2"));
t("round(1.005, 2) = 1.01", () => assert.strictEqual(rp("round(1.005,2)"), "1.01"));
t("floor(1.9) = 1", () => assert.strictEqual(rp("floor(1.9)"), "1"));
t("floor(-1.1) = -2", () => assert.strictEqual(rp("floor(-1.1)"), "-2"));
t("ceil(1.1) = 2", () => assert.strictEqual(rp("ceil(1.1)"), "2"));
t("ceil(-1.9) = -1", () => assert.strictEqual(rp("ceil(-1.9)"), "-1"));
t("min(3,1,2) = 1", () => assert.strictEqual(rp("min(3,1,2)"), "1"));
t("max(3,1,2) = 3", () => assert.strictEqual(rp("max(3,1,2)"), "3"));
t("pi 常量", () => assert.strictEqual(mp("pi"), "3.14"));
t("e 常量", () => assert.strictEqual(mp("e"), "2.72"));

/* ---------------- 输入容错 ---------------- */
t("千分位输入 1,234.5+0.5", () => assert.strictEqual(rp("1,234.5+0.5"), "1235"));
t("全角输入 （1＋2）×3", () => assert.strictEqual(rp("（1＋2）×3"), "9"));
t("乘号 x：2x3 = 6", () => assert.strictEqual(rp("2x3"), "6"));
t("结尾等号 1+2=", () => assert.strictEqual(rp("1+2="), "3"));
t("科学计数 1e3 = 1000", () => assert.strictEqual(rp("1e3"), "1000"));
t("多余空格", () => assert.strictEqual(rp("  6 / 2 "), "3"));

/* ---------------- 错误处理 ---------------- */
t("空表达式报错", () => bad(""));
t("不完整 1+ 报错", () => bad("1+"));
t("除零报错", () => bad("1/0"));
t("未知标识符报错", () => bad("abc"));
t("非法字符报错", () => bad("1 @ 2"));
t("连续小数点报错", () => bad("1..2"));

/* ---------------- 格式化 ---------------- */
t("千分位显示", () => assert.strictEqual(rt("1234567.5"), "1,234,567.5"));
t("负数显示", () => assert.strictEqual(rt("-1234.5"), "-1,234.5"));
t("金额显示（千分位）", () => {
  const r = ev("1234567.891");
  assert.strictEqual(Core.moneyText(r.value), "1,234,567.89");
});
t("金额显示负数", () => {
  const r = ev("-1234567.891");
  assert.strictEqual(Core.moneyText(r.value), "-1,234,567.89");
});

/* ---------------- 人民币大写 ---------------- */
const up = (s) => Core.rmbUpper(s);
t("大写 1234.57", () => assert.strictEqual(up("1234.57"), "壹仟贰佰叁拾肆元伍角柒分"));
t("大写 10000.00", () => assert.strictEqual(up("10000.00"), "壹万元整"));
t("大写 100000000.00", () => assert.strictEqual(up("100000000.00"), "壹亿元整"));
t("大写 1000001.00", () => assert.strictEqual(up("1000001.00"), "壹佰万零壹元整"));
t("大写 100010000.00", () => assert.strictEqual(up("100010000.00"), "壹亿零壹万元整"));
t("大写 1.05", () => assert.strictEqual(up("1.05"), "壹元零伍分"));
t("大写 0.50", () => assert.strictEqual(up("0.50"), "零元伍角整"));
t("大写 0.05", () => assert.strictEqual(up("0.05"), "零元零伍分"));
t("大写 0.00", () => assert.strictEqual(up("0.00"), "零元整"));
t("大写 -100.50", () => assert.strictEqual(up("-100.50"), "负壹佰元伍角整"));
t("大写 -0.00 → 零元整", () => assert.strictEqual(up("-0.00"), "零元整"));
t("大写 10.01", () => assert.strictEqual(up("10.01"), "壹拾元零壹分"));
t("大写 10000000000000000000.00 超上限为空", () => assert.strictEqual(up("100000000000000000000.00"), ""));
t("大写非法输入为空", () => assert.strictEqual(up("abc"), ""));

/* ---------------- 回车携带金额（财务模式） ---------------- */
t("财务模式携带值：完整结果 vs 金额", () => {
  const r = ev("100/3");
  assert.strictEqual(Core.moneyPlain(r.value), "33.33");
  assert(rp("100/3").startsWith("33.3333"));
});

/* ---------------- 汇总 ---------------- */
console.log(`\n算账稿纸 · 核心测试：${pass} 通过, ${fail} 失败（共 ${pass + fail} 项）`);
if (fail) {
  console.log("\n失败详情：");
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
} else {
  console.log("全部通过 ✓");
}
