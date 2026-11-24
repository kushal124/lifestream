export function runFakeEngine(
  dir: string,
  command: string,
  requestPath: string,
  resultPath: string,
): { code: number; signal: null; timedOut: boolean; stderr: string };
