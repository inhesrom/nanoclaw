import { STORE_DIR } from '../config.js';
import { EvenHubBenchmarkCapture } from './benchmark-capture.js';
import { finalizeBenchmark } from './benchmark-finalize.js';
import { runBenchmark } from './benchmark-runner.js';

async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, subcommand, ...rest] = args;
  const projectRoot = process.cwd();
  const capture = new EvenHubBenchmarkCapture(STORE_DIR, projectRoot);

  if (command === 'capture') {
    if (subcommand === 'status') {
      print(capture.status());
      return;
    }
    if (subcommand === 'disarm') {
      print(capture.disarm());
      return;
    }
    if (subcommand === 'arm') {
      const options = parseOptions(rest);
      const output = requireOption(options, 'output');
      const count = parseInteger(requireOption(options, 'count'), 'count');
      print(capture.arm(output, count));
      return;
    }
  }

  if (command === 'run') {
    const options = parseOptions([subcommand, ...rest].filter(Boolean));
    const manifest = requireOption(options, 'manifest');
    const runs = parseInteger(requireOption(options, 'runs'), 'runs');
    const seed = parseInteger(requireOption(options, 'seed'), 'seed');
    const result = await runBenchmark(manifest, {
      runs,
      seed,
      projectRoot,
    });
    print({ runDir: result.runDir, summary: result.summary });
    return;
  }

  if (command === 'finalize') {
    const options = parseOptions([subcommand, ...rest].filter(Boolean));
    const runDir = requireOption(options, 'run-dir');
    const intentReview = requireOption(options, 'intent-review');
    print(finalizeBenchmark(runDir, intentReview, projectRoot));
    return;
  }

  throw new Error(
    'usage: evenhub:benchmark capture arm|status|disarm, run, or finalize',
  );
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      !option?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`invalid option near ${option ?? '<end>'}`);
    }
    options.set(option.slice(2), value);
  }
  return options;
}

function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`--${name} must be an integer`);
  return parsed;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'benchmark failed';
  process.stderr.write(`evenhub benchmark: ${message}\n`);
  process.exitCode = 1;
});
