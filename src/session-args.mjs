export function parseServerArgs(argv) {
  const options = { session: undefined, repo: undefined, owner: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session-owner') { options.owner = true; continue; }
    if (arg === '--session' || arg === '--repo') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--session') options.session = value;
      else options.repo = value;
      continue;
    }
    throw new Error(`Unknown mcp-server option: ${arg}`);
  }
  if (options.owner && (!options.session || !options.repo)) throw new Error('Internal session owner requires --session and --repo.');
  return options;
}
