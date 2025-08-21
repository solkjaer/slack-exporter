#!/usr/bin/env node
"use strict";

const yargs = require("yargs");
const { hideBin } = require("yargs/helpers");

const { runExport } = require("../src/exporter");

// Support accidental duplication of the script name, e.g.:
// npx slacking-migrator slacking-migrator export --help
const argv = hideBin(process.argv);
if (argv[0] === "slacking-migrator") {
  argv.shift();
}

async function main() {
  const parsedArgv = yargs(argv)
    .scriptName("slack-exporter")
    .usage("$0 [options]\n\nExport Slack DMs and MPIMs with files, avatars, and emojis downloaded by default")
    .option("token", {
      describe:
        "Slack user token (xoxp-...). If omitted, uses SLACK_EXPORT_TOKEN env var.",
    })
    .option("out", {
      describe: "Output directory (default: ./exports/{team-name})",
    })
    .option("types", {
      describe: "Conversation types to export:\n                         im (direct messages)\n                         mpim (group DMs)\n                         im,mpim (both - default)",
    })
    .option("since", {
      describe: "Only export messages on/after this date (YYYY-MM-DD)",
    })
    .option("skip-files", {
      describe: "Skip downloading attached files (downloads by default)",
    })
    .option("skip-avatars", {
      describe: "Skip downloading user avatars (downloads by default)",
    })
    .option("skip-emojis", {
      describe: "Skip downloading custom emojis (downloads by default)",
    })
    .option("concurrency", {
      describe: "API concurrency limit (default: 4)",
    })
    .help('help')
    .alias('help', 'h')
    .wrap(120)
    .showHelpOnFail(false)
    .epilog('Files, avatars, and emojis are downloaded by default. Use skip options to disable.')
    .argv;

  const token = parsedArgv.token || process.env.SLACK_EXPORT_TOKEN;
  if (!token) {
    console.error(
      "Missing --token and SLACK_EXPORT_TOKEN. Provide a Slack user token (xoxp-...)."
    );
    process.exit(1);
  }
  // Validate since format if provided
  if (parsedArgv.since && !/^\d{4}-\d{2}-\d{2}$/.test(String(parsedArgv.since))) {
    console.error("--since must be in format YYYY-MM-DD (e.g. 2022-01-01)");
    process.exit(1);
  }

  // Get default output directory based on team name
  let outDir = parsedArgv.out;
  if (!outDir) {
    // Get team info to create dynamic default directory
    const { WebClient } = require("@slack/web-api");
    const client = new WebClient(token);
    try {
      const whoami = await client.auth.test();
      if (whoami.ok && whoami.team) {
        // Sanitize team name: lowercase, spaces to dashes, remove special chars
        const sanitizedTeam = whoami.team
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '');
        outDir = `./exports/${sanitizedTeam}`;
      } else {
        outDir = "./exports/default";
      }
    } catch (e) {
      console.warn("Could not get team info, using default directory");
      outDir = "./exports/default";
    }
  }

  await runExport({
    token,
    outDir,
    typesCsv: parsedArgv.types || "im,mpim",
    since: parsedArgv.since,
    downloadFiles: !parsedArgv["skip-files"],
    downloadAvatars: !parsedArgv["skip-avatars"],
    downloadEmojis: !parsedArgv["skip-emojis"],
    concurrency: parsedArgv.concurrency || 4,
  });
}

main().catch(console.error);


