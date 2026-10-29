// Shared precondition for live voice evals: they drive the real agent
// with the real model (the Standard ID, the only one the agent uses) on
// synthetic messages only, per AGENTS.md hard rule 2. Without a model
// key the eval skips instead of failing.
export function requireLiveVoice(t: { skip: (reason: string) => void }): boolean {
  if (!process.env.META_MODEL_API_KEY) {
    t.skip("needs META_MODEL_API_KEY");
    return false;
  }
  return true;
}

export function shortReply(maxChars: number): (message: string) => boolean {
  return (message: string) => message.length > 0 && message.length <= maxChars;
}

export function hasNoUrl(message: string): boolean {
  return !/https?:\/\/|www\./i.test(message);
}

export function namesNoModel(message: string): boolean {
  return !/muse|spark|wonder|meta|anthropic|openai|gpt|claude|llama/i.test(message);
}

export function questionCount(message: string): number {
  return (message.match(/\?/g) ?? []).length;
}
