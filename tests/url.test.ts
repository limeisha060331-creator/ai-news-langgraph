import { describe, expect, it } from "vitest";

import { normalizeUrl, urlToId } from "../src/lib/url.js";

describe("normalizeUrl", () => {
  it("剔除跟踪参数", () => {
    expect(normalizeUrl("https://openai.com/index/gpt-5/?utm_source=hn&utm_medium=social")).toBe(
      "https://openai.com/index/gpt-5",
    );
  });

  it("折叠 www 前缀", () => {
    expect(normalizeUrl("https://www.example.com/p/")).toBe("https://example.com/p");
  });

  it("给裸域名补协议头", () => {
    // HN 抓到的链接不带协议。不补的话取不到主机名，归一化会退化成原样返回，
    // 跨天去重会整条失效——这是第一版实际踩过的坑
    expect(normalizeUrl("blog.rust-lang.org/2026/10/05/Rust-1.90.0.html")).toBe(
      "https://blog.rust-lang.org/2026/10/05/Rust-1.90.0.html",
    );
  });

  it("去掉尾斜杠与锚点", () => {
    expect(normalizeUrl("https://example.com/a/?fbclid=abc#section")).toBe("https://example.com/a");
  });

  it("参数顺序不影响结果", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/a?a=1&b=2"),
    );
  });

  it("保留有意义的查询参数", () => {
    expect(normalizeUrl("https://example.com/search?q=agent&page=2")).toBe(
      "https://example.com/search?page=2&q=agent",
    );
  });

  it("空值与非法输入不抛异常", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });
});

describe("urlToId", () => {
  it("同一个 URL 稳定得到同一个 id", () => {
    const url = "https://openai.com/index/gpt-5";
    expect(urlToId(url)).toBe(urlToId(url));
    expect(urlToId(url)).toHaveLength(16);
  });
});
