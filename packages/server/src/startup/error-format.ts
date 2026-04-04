interface StartupFailureFormatOptions {
  color?: boolean;
}

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
} as const;

export function formatStartupFailureMessage(
  error: unknown,
  options: StartupFailureFormatOptions = {},
): string {
  const message = error instanceof Error ? error.message : String(error);
  const color = options.color ?? false;
  const title = colorize('Startup failed', `${ANSI.bold}${ANSI.red}`, color);
  const highlightedMessage = colorize(message, ANSI.red, color);

  if (!message.includes('\n')) {
    return `${title}: ${highlightedMessage}`;
  }

  const [headline, ...details] = message.split('\n');
  const formattedHeadline = colorize(headline, `${ANSI.bold}${ANSI.yellow}`, color);
  const formattedDetails = details
    .map((line) => `  ${colorize(line, ANSI.red, color)}`)
    .join('\n');

  return [
    title,
    '',
    formattedHeadline,
    formattedDetails,
  ].join('\n');
}

function colorize(text: string, ansiCode: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }

  return `${ansiCode}${text}${ANSI.reset}`;
}
