export function parseOptions(args) {
  const options = { caseIds: [] };
  const values = { '--case': 'caseIds', '--alias': 'alias', '--engine': 'engine', '--input': 'input', '--platform': 'platform', '--directory': 'directory' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values[arg]) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--alias' && options.alias || arg === '--engine' && options.alias && options.engine) throw new Error(`Duplicate npm alias option: ${arg}`);
      if (arg === '--case') options.caseIds.push(...value.split(',')); else options[values[arg]] = value;
    } else if (['--list', '--prepared', '--prepare', '--check'].includes(arg)) options[arg.slice(2)] = true;
    else if (options.alias && arg.startsWith('--')) (options.caseArguments ??= []).push(arg);
    else if (!arg.startsWith('-') && options.alias && !options.engine) options.engine = arg;
    else if (!arg.startsWith('-') && !options.alias && !options.suite) options.suite = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.alias && (options.check || options.prepare)) throw new Error('An npm alias cannot replace execution with standalone preparation or manifest checking');
  if (options.platform && !options.list) throw new Error('--platform is enumeration-only; execute on the real host platform');
  return options;
}
