"use strict";
const { displayText } = require("./workbuddy-display");

// Show recognizable command structure. Arbitrary arguments can contain secrets
// even when they are positional (a URL, request body, password or shell script).
const subcommands = {
  git: ["status", "diff", "log", "add", "commit", "push", "pull", "fetch", "switch", "checkout", "restore", "reset", "merge", "rebase", "branch", "clone", "show", "tag"],
  npm: ["run", "test", "install", "ci", "publish"], pnpm: ["run", "test", "install", "build"],
  cargo: ["build", "check", "test", "run", "fmt", "clippy"], docker: ["build", "run", "pull", "push", "compose", "ps"],
  kubectl: ["get", "apply", "delete", "describe", "logs"],
};
const switches = new Set(["--verbose", "--quiet", "--version", "--help", "--short", "--stat",
  "--dry-run", "--force", "--all", "--fail", "--silent", "--show-error", "--location", "--oneline"]);
const privateOptions = new Set(["-H", "-u", "-d", "-b", "-F", "-p", "--header", "--user",
  "--data", "--data-raw", "--data-binary", "--cookie", "--form", "--password", "--token",
  "--api-key", "--access-token", "--client-secret", "--oauth2-bearer"]);
const httpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function commandPreview(command) {
  if (typeof command !== "string" || !command.trim()) return "运行命令";
  // Parse only complete literal words. Stop at shell operators, expansion,
  // escapes or compound quoting rather than interpreting shell code.
  const word = /[ \t]*(?:'([^'\r\n]*)'|"([^"\\$`\r\n]*)"|([a-zA-Z0-9_./:@%+=,-]+))(?=[ \t\r\n;&|<>]|$)/y;
  const words = [];
  const input = command.trim();
  let index = 0;
  while (index < input.length && words.length < 48) {
    word.lastIndex = index;
    const match = word.exec(input);
    if (!match) break;
    words.push(match[1] ?? match[2] ?? match[3]);
    index = word.lastIndex;
  }
  // Skip environment assignments, including their values.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const executable = words.shift()?.split("/").pop();
  if (!executable || !/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]{0,63}$/.test(executable)) return "运行命令（详情见 Mac）";
  const shown = ["运行", executable];
  if (Object.hasOwn(subcommands, executable) && subcommands[executable].includes(words[0])) {
    shown.push(words.shift());
    if (["npm", "pnpm"].includes(executable) && shown[2] === "run" && ["build", "dev", "lint", "test"].includes(words[0])) shown.push(words.shift());
  }
  while (words.length) {
    const arg = words.shift();
    const option = arg.split("=", 1)[0];
    if (privateOptions.has(option)) {
      shown.push(option, "***");
      if (arg === option) words.shift();
    } else if (executable === "curl" && ["-X", "--request"].includes(arg) && httpMethods.has(words[0])) {
      shown.push(arg, words.shift());
    } else if (switches.has(arg) || (executable === "ls" && /^-[alhtrS]+$/.test(arg))) {
      shown.push(arg);
    } else {
      shown.push("***");
      if (words.length || index < input.length) shown.push("...");
      break;
    }
  }
  if (index < input.length && shown.at(-1) !== "...") shown.push("...");
  // The board font renders the Unicode ellipsis as a question mark.
  const text = displayText(shown.join(" "));
  const chars = Array.from(text);
  return chars.length > 46 ? chars.slice(0, 43).join("").trimEnd() + "..." : text;
}

module.exports = { commandPreview };
