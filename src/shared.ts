import { z } from "zod";

export const sourceShape = {
  paths: z.array(z.string()).min(1).describe("Files or directories to include. Relative paths resolve against `root`."),
  root: z
    .string()
    .optional()
    .describe("Base directory for relative paths and file labels. Defaults to the server's working directory."),
  include: z
    .array(z.string())
    .optional()
    .describe("Glob allow-list (e.g. ['*.ts','src/**']). Patterns without '/' match the file name anywhere."),
  exclude: z.array(z.string()).optional().describe("Glob deny-list (e.g. ['**/generated/**','*.snap'])."),
  exclude_tests: z
    .boolean()
    .optional()
    .describe("Skip test directories and test files (*.test.*, *.spec.*, *_test.go, *Test.java, ...)."),
  line_numbers: z.boolean().optional().describe("Prefix lines with `N| ` so answers can cite path:line. Default true."),
};
