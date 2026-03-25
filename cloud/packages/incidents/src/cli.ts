#!/usr/bin/env bun

import { listCommand } from "./commands/list";
import { getCommand } from "./commands/get";
import { logsCommand } from "./commands/logs";

const USAGE = `
Usage: bun run incidents <command> [options]

Commands:
  get <id>       Show incident details
  logs <id>      Fetch and display incident logs
  list           List recent incidents

Options:
  --help         Show this help message

Run 'bun run incidents <command> --help' for command-specific options.
`.trim();

function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
} {
  // argv[0] = bun, argv[1] = script path, argv[2+] = user args
  const userArgs = argv.slice(2);
  const command = userArgs[0] || "";
  const rest = userArgs.slice(1);

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++; // skip next
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, args: positional, flags };
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv);

  if (!command || command === "--help" || flags.help) {
    console.log(USAGE);
    process.exit(0);
  }

  switch (command) {
    case "get":
      await getCommand(args, flags);
      break;
    case "logs":
      await logsCommand(args, flags);
      break;
    case "list":
      await listCommand(args, flags);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
