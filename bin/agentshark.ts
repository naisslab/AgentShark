#!/usr/bin/env node
// AgentShark command-line entry; see src/cli/main.ts for the commands.

import { main } from '../src/cli/main.ts';

process.exitCode = await main(process.argv.slice(2));
