import { parseArgs } from 'node:util';

export function parseCliOptions(args = process.argv.slice(2)) {
  const { values, positionals, tokens } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      new: { type: 'boolean' },
      web: { type: 'boolean' },
      session: { type: 'string' },
      'state-dir': { type: 'string' },
      'trusted-commands': { type: 'boolean' },
      'instructions-file': { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    tokens: true,
  });
  const command = positionals[0] ?? 'new';
  const sessionId = values.session ?? (command === 'resume' ? positionals[1] : undefined);
  if (!values.help && !values.version) {
    if (values['instructions-file'] !== undefined) {
      if (!values['instructions-file'].trim())
        throw new Error('--instructions-file requires a nonempty path.');
      if (
        tokens.filter((token) => token.kind === 'option' && token.name === 'instructions-file')
          .length !== 1
      )
        throw new Error('Specify --instructions-file only once.');
      if (command !== 'new' || sessionId !== undefined)
        throw new Error('--instructions-file is only available for a new conversation.');
    }
    if (
      (positionals.length && !['resume', 'doctor'].includes(command)) ||
      positionals.length > (command === 'resume' ? 2 : 1)
    )
      throw new Error('Unknown command. Run chittr --help.');
    if (values.new && (command === 'resume' || sessionId !== undefined))
      throw new Error('Choose a new chat or resume a saved chat, not both.');
    if (command === 'resume' && positionals[1] !== undefined && values.session !== undefined)
      throw new Error('Specify the saved session ID only once.');
    if (sessionId !== undefined && !sessionId.trim())
      throw new Error('A saved session ID cannot be empty.');
  }
  return { values, command, sessionId };
}
