/*!
 * 算账稿纸 · 核心引擎
 * ------------------------------------------------------------
 * · 高精度十进制运算：基于 BigInt 实现，加减乘完全精确，除法保留 36 位有效数字
 * · 表达式解析：递归下降，支持 + - * / ^ % ( ) 与常用函数
 * · 金额工具：四舍五入到分（round-half-up）、千分位格式化、人民币大写
 *
 * 该文件不依赖任何第三方库，可同时在浏览器（window.SZCore）与
 * Node.js（module.exports）中运行，便于单元测试。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.SZCore = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var MAX_SIG = 40; // 结果最多保留的有效数字位数
  var DIV_SIG = 36; // 除法运算保留的有效数字位数
  var DIGITS = "零壹贰叁肆伍陆柒捌玖";

  /* ============================ 十进制数 ============================ */
  // 表示： m * 10^e ，其中 m 为 BigInt。所有函数均为纯函数。

  function dec(m, e) { return { m: m, e: e }; }
  var ZERO = dec(0n, 0);

  function isZero(x) { return x.m === 0n; }
  function negate(x) { return dec(-x.m, x.e); }
  function abs(x) { return x.m < 0n ? dec(-x.m, x.e) : x; }

  function digitsOf(m) {
    if (m === 0n) return 1;
    return (m < 0n ? -m : m).toString().length;
  }

  function pow10(n) { return 10n ** BigInt(n); }

  /** 削减到 MAX_SIG 位有效数字（四舍五入，半值远离零） */
  function norm(x) {
    if (x.m === 0n) return ZERO;
    var negative = x.m < 0n;
    var m = negative ? -x.m : x.m;
    var len = m.toString().length;
    if (len <= MAX_SIG) return x;
    var drop = len - MAX_SIG;
    var p = pow10(drop);
    var q = m / p, r = m % p;
    if (r * 2n >= p) q += 1n;
    var e = x.e + drop;
    while (q >= pow10(MAX_SIG)) { q /= 10n; e += 1; }
    return dec(negative ? -q : q, e);
  }

  /** 解析十进制字符串（支持 1.23、.5、1e3 等形式），失败返回 null */
  function parseNumber(str) {
    if (typeof str !== "string") return null;
    var m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str.trim());
    if (!m) return null;
    var ip = m[2] || "", fp = m[3] || "";
    if (!ip && !fp) return null;
    var exp = m[4] ? parseInt(m[4], 10) : 0;
    var d = (ip + fp).replace(/^0+/, "");
    if (d === "") return ZERO;
    var v = BigInt(d);
    if (m[1] === "-") v = -v;
    return norm(dec(v, exp - fp.length));
  }

  /** 对齐两个数的指数，返回 [ma, mb, e] */
  function align(a, b) {
    var e = a.e < b.e ? a.e : b.e;
    return [a.m * pow10(a.e - e), b.m * pow10(b.e - e), e];
  }

  function add(a, b) { var t = align(a, b); return norm(dec(t[0] + t[1], t[2])); }
  function sub(a, b) { var t = align(a, b); return norm(dec(t[0] - t[1], t[2])); }
  function mul(a, b) { return norm(dec(a.m * b.m, a.e + b.e)); }
  function cmp(a, b) { var t = align(a, b); return t[0] < t[1] ? -1 : (t[0] > t[1] ? 1 : 0); }

  /** 除法：保留 DIV_SIG 位有效数字，无法除尽时四舍五入 */
  function divide(a, b) {
    if (isZero(b)) return null;
    var negative = (a.m < 0n) !== (b.m < 0n);
    var A = a.m < 0n ? -a.m : a.m;
    var B = b.m < 0n ? -b.m : b.m;
    var k = DIV_SIG - (digitsOf(A) - digitsOf(B));
    if (k < 0) k = 0;
    var P = pow10(k);
    var q = (A * P) / B;
    var r = (A * P) % B;
    if (r * 2n >= B) q += 1n;
    return norm(dec(negative ? -q : q, a.e - b.e - k));
  }

  function powInt(a, n) {
    if (n === 0n) return dec(1n, 0);
    var negative = n < 0n;
    if (negative) n = -n;
    var result = dec(1n, 0), base = a;
    while (n > 0n) {
      if (n & 1n) result = mul(result, base);
      n >>= 1n;
      if (n > 0n) base = mul(base, base);
    }
    return negative ? divide(dec(1n, 0), result) : result;
  }

  function toNumber(x) { return Number(x.m) * Math.pow(10, x.e); }
  function fromNumber(n) {
    if (!isFinite(n)) return null;
    if (n === 0) return ZERO;
    return parseNumber(n.toPrecision(16));
  }

  function pow(a, b) {
    if (b.e >= 0) {
      var n = b.m * pow10(b.e);
      if (n >= -9999n && n <= 9999n) {
        var r = powInt(a, n);
        return r;
      }
    }
    return fromNumber(Math.pow(toNumber(a), toNumber(b)));
  }

  function bigintSqrt(n) {
    if (n < 2n) return n;
    var x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    var y = (x + n / x) >> 1n;
    while (y < x) { x = y; y = (x + n / x) >> 1n; }
    return x;
  }

  function sqrt(a) {
    if (a.m < 0n) return null;
    if (isZero(a)) return ZERO;
    var m = a.m, e = a.e;
    if (e % 2 !== 0) { m *= 10n; e -= 1; }
    var k = 41 - Math.ceil(digitsOf(m) / 2);
    if (k < 0) k = 0;
    var s = bigintSqrt(m * pow10(2 * k));
    var str = s.toString();
    if (str.length > MAX_SIG) {
      var drop = str.length - MAX_SIG;
      var p = pow10(drop);
      var q = s / p, r = s % p;
      if (r * 2n >= p) q += 1n;
      s = q;
      k -= drop;
    }
    return norm(dec(s, (e - 2 * k) / 2));
  }

  /** 四舍五入到 dp 位小数（半值远离零） */
  function roundDp(a, dp) {
    return parseNumber(toFixed(a, dp));
  }

  function scaledInt(a, dp, mode) {
    var shift = a.e + dp;
    if (shift >= 0) return dec(a.m * pow10(shift), -dp);
    var p = pow10(-shift);
    var q = a.m / p, r = a.m % p;
    if (mode === "floor" && r !== 0n && a.m < 0n) q -= 1n;
    if (mode === "ceil" && r !== 0n && a.m > 0n) q += 1n;
    return dec(q, -dp);
  }

  /** 输出普通十进制字符串（无科学计数法、无多余尾零） */
  function toText(x) {
    if (x.m === 0n) return "0";
    var negative = x.m < 0n;
    var s = (negative ? -x.m : x.m).toString();
    var out;
    if (x.e >= 0) {
      out = s + "0".repeat(x.e);
    } else {
      var dp = -x.e;
      if (s.length <= dp) out = "0." + "0".repeat(dp - s.length) + s;
      else out = s.slice(0, s.length - dp) + "." + s.slice(s.length - dp);
      out = out.replace(/0+$/, "").replace(/\.$/, "");
    }
    return (negative ? "-" : "") + out;
  }

  /** 定点输出：精确保留 dp 位小数（半值远离零） */
  function toFixed(x, dp) {
    if (dp < 0) dp = 0;
    var negative = x.m < 0n;
    var m = negative ? -x.m : x.m;
    var unscaled;
    var shift = dp + x.e;
    if (shift >= 0) {
      unscaled = m * pow10(shift);
    } else {
      var p = pow10(-shift);
      var q = m / p, r = m % p;
      unscaled = (r * 2n >= p) ? q + 1n : q;
    }
    var s = unscaled.toString();
    if (dp > 0) {
      s = s.padStart(dp + 1, "0");
      s = s.slice(0, s.length - dp) + "." + s.slice(s.length - dp);
    }
    return (negative && unscaled !== 0n ? "-" : "") + s;
  }

  /** 千分位分组（输入为普通数字字符串） */
  function group(str) {
    var s = String(str);
    var sign = "";
    if (s[0] === "-") { sign = "-"; s = s.slice(1); }
    var parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return sign + parts.join(".");
  }

  /* ============================ 人民币大写 ============================ */

  var BIG_UNITS = ["", "万", "亿", "万亿", "亿亿"];
  var SMALL_UNITS = ["", "拾", "佰", "仟"];

  function sectionUpper(sec) {
    var out = "", zero = false;
    for (var i = 0; i < sec.length; i++) {
      var d = +sec[i];
      var u = sec.length - 1 - i;
      if (d === 0) { zero = true; continue; }
      if (zero && out) out += "零";
      zero = false;
      out += DIGITS[d] + SMALL_UNITS[u];
    }
    return out;
  }

  function intUpper(intStr) {
    if (!intStr || intStr === "0") return "";
    var groups = [];
    var t = intStr;
    while (t.length > 4) { groups.unshift(t.slice(-4)); t = t.slice(0, -4); }
    groups.unshift(t);
    if (groups.length > BIG_UNITS.length) return null;
    var out = "";
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var big = BIG_UNITS[groups.length - 1 - i];
      if (+g === 0) {
        if (out && !/零$/.test(out)) out += "零";
        continue;
      }
      if (out && g.padStart(4, "0")[0] === "0" && !/零$/.test(out)) out += "零";
      out += sectionUpper(g) + big;
    }
    return out.replace(/零+$/, "");
  }

  /** 人民币大写（输入为 toFixed(2) 的普通数字字符串） */
  function rmbUpper(plain) {
    var s = String(plain == null ? "" : plain);
    if (!/^-?\d+(\.\d+)?$/.test(s)) return "";
    var sign = "";
    if (s[0] === "-") { sign = "负"; s = s.slice(1); }
    if (!/[1-9]/.test(s)) return "零元整";
    var parts = s.split(".");
    var intPart = parts[0].replace(/^0+(?=\d)/, "");
    var frac = (parts[1] || "") + "00";
    var jiao = +frac[0], fen = +frac[1];
    var upper = intUpper(intPart);
    if (upper === null) return "";
    var base = upper || "零";
    var body;
    if (jiao === 0 && fen === 0) body = base + "元整";
    else if (jiao === 0) body = base + "元零" + DIGITS[fen] + "分";
    else if (fen === 0) body = base + "元" + DIGITS[jiao] + "角整";
    else body = base + "元" + DIGITS[jiao] + "角" + DIGITS[fen] + "分";
    return sign + body;
  }

  /* ============================ 表达式解析 ============================ */

  var CONSTS = { pi: null, e: null };
  CONSTS.pi = parseNumber(Math.PI.toPrecision(16));
  CONSTS.e = parseNumber(Math.E.toPrecision(16));

  function normalizeExpr(src) {
    var s = String(src == null ? "" : src);
    s = s.replace(/[（）＋－×÷％．，。：＊／＝]/g, function (c) {
      return { "（": "(", "）": ")", "＋": "+", "－": "-", "×": "*", "÷": "/",
        "％": "%", "．": ".", "，": ",", "。": ".", "：": ":", "＊": "*", "／": "/", "＝": "=" }[c];
    });
    s = s.replace(/[０-９ａ-ｚＡ-Ｚ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/(\d),(?=\d{3}(\D|$))/g, "$1");
    s = s.replace(/([\d)]) *[xX] *(?=[\d(.])/g, "$1*");
    s = s.replace(/[=]\s*$/, "");
    return s;
  }

  function tokenize(s) {
    var tokens = [], i = 0;
    while (i < s.length) {
      var c = s[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c >= "0" && c <= "9" || c === ".") {
        var j = i, dot = false;
        while (j < s.length && (s[j] >= "0" && s[j] <= "9" || s[j] === ".")) {
          if (s[j] === ".") { if (dot) break; dot = true; }
          j++;
        }
        if (j < s.length && (s[j] === "e" || s[j] === "E")) {
          var j2 = j + 1;
          if (j2 < s.length && (s[j2] === "+" || s[j2] === "-")) j2++;
          var j3 = j2;
          while (j3 < s.length && s[j3] >= "0" && s[j3] <= "9") j3++;
          if (j3 > j2) j = j3;
        }
        tokens.push({ t: "num", v: s.slice(i, j) });
        i = j; continue;
      }
      if (/[a-zA-Z]/.test(c)) {
        var k = i;
        while (k < s.length && /[a-zA-Z]/.test(s[k])) k++;
        tokens.push({ t: "ident", v: s.slice(i, k).toLowerCase() });
        i = k; continue;
      }
      if (c === "π") { tokens.push({ t: "ident", v: "pi" }); i++; continue; }
      if ("+-*/^%(),".indexOf(c) >= 0) { tokens.push({ t: c }); i++; continue; }
      return { error: "无法识别的字符 “" + c + "”" };
    }
    return { tokens: tokens };
  }

  function intValueOf(x) {
    if (x.e < 0) {
      if (x.m % pow10(-x.e) !== 0n) return null;
      return Number(x.m / pow10(-x.e));
    }
    var v = x.m * pow10(x.e);
    if (v > 100000n || v < -100000n) return null;
    return Number(v);
  }

  function callFunction(name, args) {
    switch (name) {
      case "sqrt":
        if (args.length !== 1) return null;
        return sqrt(args[0]);
      case "abs":
        return args.length === 1 ? abs(args[0]) : null;
      case "round": {
        if (args.length === 1) return roundDp(args[0], 0);
        if (args.length === 2) { var dp1 = intValueOf(args[1]); return dp1 === null ? null : roundDp(args[0], Math.max(0, Math.min(20, dp1))); }
        return null;
      }
      case "floor": {
        if (args.length === 1) return scaledInt(args[0], 0, "floor");
        if (args.length === 2) { var dp2 = intValueOf(args[1]); return dp2 === null ? null : scaledInt(args[0], Math.max(0, Math.min(20, dp2)), "floor"); }
        return null;
      }
      case "ceil": {
        if (args.length === 1) return scaledInt(args[0], 0, "ceil");
        if (args.length === 2) { var dp3 = intValueOf(args[1]); return dp3 === null ? null : scaledInt(args[0], Math.max(0, Math.min(20, dp3)), "ceil"); }
        return null;
      }
      case "min":
        if (args.length < 1) return null;
        return args.reduce(function (a, b) { return cmp(a, b) <= 0 ? a : b; });
      case "max":
        if (args.length < 1) return null;
        return args.reduce(function (a, b) { return cmp(a, b) >= 0 ? a : b; });
      default:
        return undefined; // 未知函数
    }
  }

  /** 求值：成功返回 { ok: true, value }；失败返回 { ok: false, error } */
  function evaluate(expression) {
    var src = normalizeExpr(expression);
    if (!src.trim()) return { ok: false, error: "空表达式" };
    var tk = tokenize(src);
    if (tk.error) return { ok: false, error: tk.error };
    var tokens = tk.tokens, pos = 0;

    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function parsePrimary() {
      var tk0 = peek();
      if (!tk0) return { error: "表达式不完整" };
      if (tk0.t === "num") {
        next();
        var v = parseNumber(tk0.v);
        if (!v) return { error: "数字格式有误：" + tk0.v };
        return { value: v };
      }
      if (tk0.t === "ident") {
        next();
        var name = tk0.v;
        if (peek() && peek().t === "(") {
          next();
          var args = [];
          if (peek() && peek().t === ")") next();
          else {
            for (;;) {
              var a = parseExpr();
              if (a.error) return a;
              args.push(a.value);
              var sep = peek();
              if (sep && sep.t === ",") { next(); continue; }
              if (sep && sep.t === ")") { next(); break; }
              return { error: "缺少右括号" };
            }
          }
          var res = callFunction(name, args);
          if (res === undefined) return { error: "未知函数：" + name };
          if (res === null) return { error: "函数 " + name + " 的参数或结果无效" };
          return { value: res };
        }
        if (name in CONSTS && CONSTS[name]) return { value: CONSTS[name] };
        return { error: "未知标识符：" + name };
      }
      if (tk0.t === "(") {
        next();
        var inner = parseExpr();
        if (inner.error) return inner;
        var close = peek();
        if (!close || close.t !== ")") return { error: "缺少右括号" };
        next();
        return inner;
      }
      return { error: "表达式不完整或格式有误" };
    }

    function parsePostfix() {
      var base = parsePrimary();
      if (base.error) return base;
      while (peek() && peek().t === "%") {
        next();
        base = { value: divide(base.value, dec(100n, 0)) };
      }
      return base;
    }

    function parseUnary() {
      var tk0 = peek();
      if (tk0 && tk0.t === "-") { next(); var v = parseUnary(); if (v.error) return v; return { value: negate(v.value) }; }
      if (tk0 && tk0.t === "+") { next(); return parseUnary(); }
      return parsePower();
    }

    function parsePower() {
      var base = parsePostfix();
      if (base.error) return base;
      if (peek() && peek().t === "^") {
        next();
        var exp = parseUnary();
        if (exp.error) return exp;
        var r = pow(base.value, exp.value);
        if (!r) return { error: "幂运算结果无效" };
        return { value: r };
      }
      return base;
    }

    function parseTerm() {
      var left = parseUnary();
      if (left.error) return left;
      for (;;) {
        var op = peek();
        if (!op || (op.t !== "*" && op.t !== "/")) return left;
        next();
        var right = parseUnary();
        if (right.error) return right;
        if (op.t === "*") left = { value: mul(left.value, right.value) };
        else {
          var d = divide(left.value, right.value);
          if (!d) return { error: "除数不能为 0" };
          left = { value: d };
        }
      }
    }

    function parseExpr() {
      var left = parseTerm();
      if (left.error) return left;
      for (;;) {
        var op = peek();
        if (!op || (op.t !== "+" && op.t !== "-")) return left;
        next();
        var right = parseTerm();
        if (right.error) return right;
        left = { value: op.t === "+" ? add(left.value, right.value) : sub(left.value, right.value) };
      }
    }

    var result = parseExpr();
    if (result.error) return { ok: false, error: result.error };
    if (pos < tokens.length) return { ok: false, error: "表达式格式有误" };
    return { ok: true, value: result.value };
  }

  /* ============================ 对外接口 ============================ */

  return {
    evaluate: evaluate,
    /** 显示用结果（含千分位），如 "1,234.567" */
    resultText: function (v) { return group(toText(v)); },
    /** 复制/携带用结果（无千分位），如 "1234.567" */
    resultPlain: function (v) { return toText(v); },
    /** 财务金额（固定 2 位小数，无千分位），如 "1234.57" */
    moneyPlain: function (v) { return toFixed(v, 2); },
    /** 财务金额显示（千分位，固定 2 位小数），如 "1,234.57" */
    moneyText: function (v) { return group(toFixed(v, 2)); },
    rmbUpper: rmbUpper,
    group: group,
    _internal: {
      parseNumber: parseNumber,
      toText: toText,
      toFixed: toFixed,
      add: add,
      sub: sub,
      mul: mul,
      divide: divide,
      pow: pow,
      sqrt: sqrt,
      cmp: cmp,
      roundDp: roundDp,
      normalizeExpr: normalizeExpr
    }
  };
});
