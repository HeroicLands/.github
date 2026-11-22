/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

export function inputError(inputPath, message) {
  return Object.assign(new Error(message), { inputPath });
}

export async function atInput(inputPath, action) {
  try {
    return await action();
  } catch (error) {
    error.inputPath ??= error.path ?? inputPath;
    throw error;
  }
}

export async function readJson(inputPath, validate) {
  return atInput(inputPath, async () => {
    const text = await readFile(inputPath, "utf8");
    try {
      const value = JSON.parse(text);
      validate(value);
      return value;
    } catch (error) {
      let offset = -1;
      if (error.literal !== undefined) {
        const literal = JSON.stringify(error.literal);
        for (const match of text.matchAll(/"path"\s*:\s*/g)) {
          const start = match.index + match[0].length;
          if (text.startsWith(literal, start)) {
            offset = start;
            break;
          }
        }
      }
      if (offset >= 0) {
        const before = text.slice(0, offset).split("\n");
        error.line = before.length;
        error.column = before.at(-1).length + 1;
      } else if (error instanceof SyntaxError) {
        const position = error.message.match(/\(line (\d+) column (\d+)\)/);
        if (position) [, error.line, error.column] = position;
      }
      throw error;
    }
  });
}

export function report(error) {
  const input = error.inputPath ?? error.path;
  const location = input
    ? path.relative(process.cwd(), path.resolve(input)) || "."
    : "<arguments>";
  process.stderr.write(
    `${[location, error.line, error.column].filter((part) => part !== undefined).join(":")}: error: ${error.message.replaceAll("\n", " ")}${error.refreshSnapshot ? ". Refresh the trusted dependency snapshot and review its lock before retrying." : ""}\n`,
  );
  process.exitCode = 1;
}
