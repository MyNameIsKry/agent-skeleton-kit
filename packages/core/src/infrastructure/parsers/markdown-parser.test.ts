import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown-parser.js";

describe("parseMarkdown", () => {
  it("splits at headings and records the heading path", () => {
    const { sections } = parseMarkdown(
      [
        "Intro before any heading.",
        "",
        "# Handbook",
        "Welcome.",
        "## Leave",
        "### Sick leave",
        "Tell your manager.",
        "## Equipment",
        "Laptops are issued on day one.",
      ].join("\n"),
    );
    expect(sections).toEqual([
      { headingPath: [], text: "Intro before any heading." },
      { headingPath: ["Handbook"], text: "Welcome." },
      { headingPath: ["Handbook", "Leave", "Sick leave"], text: "Tell your manager." },
      { headingPath: ["Handbook", "Equipment"], text: "Laptops are issued on day one." },
    ]);
  });

  it("drops sections with only whitespace", () => {
    expect(parseMarkdown("# A\n\n   \n## B\nText").sections).toEqual([
      { headingPath: ["A", "B"], text: "Text" },
    ]);
  });

  it("does not treat lines inside fenced code blocks as headings", () => {
    const { sections } = parseMarkdown(
      ["# Setup", "```bash", "# install deps", "npm ci", "```", "Done."].join("\n"),
    );
    expect(sections).toEqual([
      { headingPath: ["Setup"], text: "```bash\n# install deps\nnpm ci\n```\nDone." },
    ]);
  });

  it("closes a fence only with a matching marker of at least the same length", () => {
    const { sections } = parseMarkdown(["~~~~", "```", "# not a heading", "~~~~", "# Real"].join("\n"));
    expect(sections.map((s) => s.headingPath)).toEqual([[]]);
    expect(parseMarkdown(["~~~~", "~~~~", "# Real", "x"].join("\n")).sections.at(-1)?.headingPath).toEqual([
      "Real",
    ]);
  });

  it("strips inline formatting, closing hashes, front matter, a BOM, and CRLF", () => {
    const text = "\uFEFF---\ntitle: x\n---\r\n# The **[VPN](https://vpn) guide** ##\r\nUse `vpnctl`.\r\n";
    expect(parseMarkdown(text).sections).toEqual([{ headingPath: ["The VPN guide"], text: "Use `vpnctl`." }]);
  });

  it("requires a space after the hashes and at most three spaces of indent", () => {
    const { sections } = parseMarkdown("#hashtag\n    # indented code\n");
    expect(sections).toEqual([{ headingPath: [], text: "#hashtag\n    # indented code" }]);
  });
});
