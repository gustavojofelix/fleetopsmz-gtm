/**
 * CLI entry point. This file only dispatches commands; see src/cli/commands.ts.
 * Nothing in this program sends an email, WhatsApp or LinkedIn message.
 */
import {
  checkConfig,
  exportApprovedCommand,
  reportCommand,
  resumeCommand,
  runCommand,
} from './cli/commands.js';
import { toPipelineError } from './infra/errors.js';

const USAGE = `Usage: npm run pipeline -- <command> [options]

Commands:
  check-config        Validate .env and the files under config/
  run                 Run one or more agents
  resume <run_id>     Repeat an earlier run with the same options (finished work is reused)
  report              Write a KPI report to data/reports/
  export-approved     Write approved drafts to a CSV for manual sending

Options for run:
  --agents <list>     minerador | pesquisador | copywriter, comma-separated and adjacent
                      (default: minerador)
  --input <file>      Raw CSV or JSON file for minerador; repeat for several files
  --company <name>    Assess a single company instead of a file (with --city, --website)
  --from-run <id>     Run to read from when starting at pesquisador or copywriter
                      (default: the newest run of the previous stage)
  --lead <lead_id>    Process only this lead (pesquisador, copywriter)
  --limit <n>         Maximum companies to process (default: DEFAULT_BATCH_LIMIT)
  --confirm-large     Required when --limit exceeds DEFAULT_BATCH_LIMIT
  --dry-run           minerador only: import and deduplicate, no model calls, nothing written
  --force             Ignore cached results and call the providers again
`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = process.cwd();
  switch (command) {
    case 'check-config':
      return checkConfig(root);
    case 'run':
      return runCommand(root, rest);
    case 'resume':
      return resumeCommand(root, rest);
    case 'report':
      return reportCommand(root);
    case 'export-approved':
      return exportApprovedCommand(root);
    default:
      process.stderr.write(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const failure = toPipelineError(error);
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'cli.failed', ...failure.toJSON() })}\n`);
    process.exitCode = 1;
  });
